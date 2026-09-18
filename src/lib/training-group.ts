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

/**
 * The types whose `certification[]` ("leads to") is meaningful: a training that
 * prepares somebody for a certification. The schema lets a `Certification` row
 * carry the column too, but nothing reads it that way — `lib/leads-to.ts` roots
 * the Trained-But-Not-Certified graph on ILT/OLX, and the Full Title editor only
 * offers the section for those two. Shared so the editor and the integrity scan
 * agree on which groups are even in scope.
 */
export const CERT_BEARING_TYPES: TrainingType[] = ["InstructorLedTraining", "OLX"];

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
 * Safe for OLX sub-items too, but only since `lib/olx.ts` began counting a
 * parent's sub-items per `(fullTitle, trainingType)` group. While that rule was
 * per training title, expanding a sub-item Full Title to all its spellings made
 * the parent completable only by somebody who had taken every spelling — i.e.
 * nobody. If that rule is ever reverted, this expansion has to go back to being
 * certification- and replacement-only.
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

/**
 * Rewrite or scrub every reference to a `trainingTitle` held in another row's
 * `certification[]` ("leads to") or `replacedBy[]` (legacy replacement).
 *
 * Those two columns are bare `String[]`s holding primary keys with no foreign
 * key behind them — unlike `OlxSubItemRelation`, which is a real join table with
 * cascades. So nothing kept them honest: renaming a certification rewrote
 * `trainingTaken` and both sides of the OLX join table but left every training
 * that pointed at it holding a key that no longer existed, and deleting one left
 * the same dangling key behind.
 *
 * It failed silently, which is what made it worth fixing: every consumer renders
 * an unresolvable reference with a `?? title` fallback, so the UI showed the old
 * internal key where a name should be, and the reports simply stopped matching
 * the holders. `sanitizeLegacyFields` would then quietly drop the dead entry the
 * next time that *other* row happened to be saved.
 *
 * Pass `to: null` to remove the reference (a delete); pass a title to repoint it
 * (a rename). Runs inside the caller's transaction, beside the writes it must
 * stay consistent with.
 *
 * Postgres has no array-element update in Prisma's query API, so the rows are
 * read and rewritten individually. Only rows that actually reference the title
 * are touched, which is a very small set in practice.
 */
export async function rewriteTitleReferences(
  tx: PrismaTransactionClient,
  from: string,
  to: string | null,
): Promise<void> {
  const affected = await tx.trainingData.findMany({
    where: {
      OR: [{ certification: { has: from } }, { replacedBy: { has: from } }],
    },
    select: { trainingTitle: true, certification: true, replacedBy: true },
  });

  for (const row of affected) {
    // The renamed row itself is deleted and recreated by the rename path, so
    // skip it here rather than writing to a row that is about to disappear.
    if (row.trainingTitle === from) continue;

    const remap = (list: string[]) => {
      if (!list.includes(from)) return list;
      const next = list.filter((t) => t !== from);
      // Guard against duplicates: the row may already reference the new title.
      if (to !== null && !next.includes(to)) next.push(to);
      return next;
    };

    await tx.trainingData.update({
      where: { trainingTitle: row.trainingTitle },
      data: {
        certification: remap(row.certification),
        replacedBy: remap(row.replacedBy),
      },
    });
  }
}

export interface TitleReferenceCounts {
  programRequirements: number;
  offeringRequirements: number;
}

/**
 * How many partner-program and offering requirements name any of these training
 * titles, counting a requirement's alternatives as well as its primary training.
 *
 * Used to warn before a move or a merge. Requirements store ONE representative
 * `trainingTitle` and expand it to its `(fullTitle, trainingType)` group at
 * counting time (`resolveSiblingTitles`), so regrouping a title changes which
 * holders those requirements count — in both directions, and silently.
 *
 * Call it over the members of BOTH the source and the destination group, not
 * just the titles being moved: a requirement naming a sibling that stays behind
 * is equally affected, because its group has shrunk.
 */
export async function countTitleReferences(
  trainingTitles: unknown,
  client: Client = prisma,
): Promise<TitleReferenceCounts> {
  const titles = dedupeTitles(trainingTitles);
  if (titles.length === 0) {
    return { programRequirements: 0, offeringRequirements: 0 };
  }
  const where = { trainingTitle: { in: titles } };
  const [program, programAlt, offering, offeringAlt] = await Promise.all([
    client.programData.count({ where }),
    client.programDataAlternative.count({ where }),
    client.offeringData.count({ where }),
    client.offeringDataAlternative.count({ where }),
  ]);
  return {
    programRequirements: program + programAlt,
    offeringRequirements: offering + offeringAlt,
  };
}
