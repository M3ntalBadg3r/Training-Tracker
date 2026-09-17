import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { TrainingType, FunctionType } from "@prisma/client";

/**
 * Full Title <-> Training Title plumbing.
 *
 * A `trainingTitle` is the primary key, but it is really just the spelling a
 * training arrives under in a customer's import file. The unit an admin manages
 * — and the unit every consumer counts on — is `(fullTitle, trainingType)`; see
 * `resolveSiblingTitles` in `lib/program-compliance.ts`, whose sibling expansion
 * groups on exactly that pair.
 *
 * So the admin API speaks Full Titles on the wire and expands to member training
 * titles HERE, on the server. The alternative — expanding in the browser — is
 * what `admin/training-data/[fullTitle]/page.tsx` used to do for legacy
 * replacements: the client had to hold the whole catalogue just to translate,
 * and the server trusted whatever came back.
 *
 * Server-only: imports Prisma, so never import this from a `"use client"` file.
 */

type Client = typeof prisma | PrismaTransactionClient;

export const isTrainingType = (v: unknown): v is TrainingType =>
  typeof v === "string" && Object.values(TrainingType).includes(v as TrainingType);

export const isFunctionType = (v: unknown): v is FunctionType =>
  typeof v === "string" && Object.values(FunctionType).includes(v as FunctionType);

/** The identity a training is actually counted under, everywhere downstream. */
export const pairKey = (fullTitle: string, trainingType: string): string =>
  `${fullTitle}::${trainingType}`;

/** Strings, trimmed, non-empty, deduped — the shape every picker sends. */
export function dedupeTitles(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return Array.from(
    new Set(
      arr
        .filter((x): x is string => typeof x === "string" && !!x.trim())
        .map((x) => x.trim()),
    ),
  );
}

/**
 * Full Titles -> every member `trainingTitle`, optionally restricted by type and
 * optionally excluding some Full Titles (a group must not be able to lead to
 * itself).
 *
 * Restricting by type matters because a Full Title can carry members of more
 * than one type: "leads to" may only ever point at a Certification.
 *
 * Returns every member rather than one representative, so an existing row keeps
 * working with no read-side change and a variant imported later is picked up by
 * the sibling expansion in `program-compliance.ts`.
 *
 * NOT suitable for OLX sub-items. Sub-item completion is AND
 * (`lib/olx.ts` requires every listed sub-item), whereas `certification[]` is
 * OR, so expanding a sub-item Full Title to all its variants would make the
 * parent completable only by someone who took every variant.
 */
export async function expandFullTitles(
  fullTitles: unknown,
  opts: { types?: TrainingType[]; excludeFullTitles?: string[] } = {},
  client: Client = prisma,
): Promise<string[]> {
  const wanted = dedupeTitles(fullTitles);
  const excluded = new Set(opts.excludeFullTitles ?? []);
  const targets = wanted.filter((f) => !excluded.has(f));
  if (targets.length === 0) return [];

  const rows = await client.trainingData.findMany({
    where: {
      fullTitle: { in: targets },
      ...(opts.types && opts.types.length > 0 ? { trainingType: { in: opts.types } } : {}),
    },
    select: { trainingTitle: true },
  });
  return rows.map((r) => r.trainingTitle);
}

/**
 * `trainingTitle`s -> the distinct Full Titles they belong to, for read-back.
 * Titles with no catalogue row fall through as themselves, matching the
 * `titleToFull.get(t) ?? t` fallback the UI has always used — a dangling
 * reference should render as the raw key rather than vanish.
 */
export async function collapseToFullTitles(
  trainingTitles: unknown,
  client: Client = prisma,
): Promise<string[]> {
  const wanted = dedupeTitles(trainingTitles);
  if (wanted.length === 0) return [];

  const rows = await client.trainingData.findMany({
    where: { trainingTitle: { in: wanted } },
    select: { trainingTitle: true, fullTitle: true },
  });
  const byTitle = new Map(rows.map((r) => [r.trainingTitle, r.fullTitle]));
  return Array.from(new Set(wanted.map((t) => byTitle.get(t) ?? t)));
}

export interface FullTitleOption {
  fullTitle: string;
  trainingTypes: TrainingType[];
  memberCount: number;
}

/**
 * The option list every Full Title picker renders: one entry per Full Title,
 * carrying the types it covers and how many training titles it bundles.
 *
 * This is what lets a picker stop listing raw `trainingTitle`s. The old pickers
 * mapped `t.trainingTitle` while *labelling* the row with `fullTitle`, so a Full
 * Title with three import variants appeared three times with identical text and
 * the admin had to guess which to tick.
 */
export async function listFullTitleOptions(
  opts: { types?: TrainingType[] } = {},
  client: Client = prisma,
): Promise<FullTitleOption[]> {
  const rows = await client.trainingData.findMany({
    where: opts.types && opts.types.length > 0 ? { trainingType: { in: opts.types } } : {},
    select: { fullTitle: true, trainingType: true },
    orderBy: { fullTitle: "asc" },
  });

  const byFull = new Map<string, { types: Set<TrainingType>; count: number }>();
  for (const r of rows) {
    const entry = byFull.get(r.fullTitle) ?? { types: new Set<TrainingType>(), count: 0 };
    entry.types.add(r.trainingType);
    entry.count += 1;
    byFull.set(r.fullTitle, entry);
  }

  return Array.from(byFull.entries()).map(([fullTitle, e]) => ({
    fullTitle,
    trainingTypes: Array.from(e.types),
    memberCount: e.count,
  }));
}
