import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { computeExpiryDate } from "@/lib/utils";

type Client = typeof prisma | PrismaTransactionClient;

/** One membership row, with just enough of the sub-item to key the group. */
type MembershipRow = {
  subItemTrainingTitle: string;
  subItem: { fullTitle: string; trainingType: string } | null;
};

/**
 * The parent's sub-items, one entry per DISTINCT sub-item, holding every
 * spelling of it. This is the single definition of what "every sub-item" counts
 * over, and it is shared by the engine (`recomputeParentsForStudent`) and the
 * read-only scan (`scanOlxParentState`) precisely so the two cannot disagree —
 * the scan is what the admin UI shows before running a backfill, so a drift
 * between them would make the preview lie about what the fix is going to do.
 *
 * A title whose catalogue row has gone missing keeps itself as its own group, so
 * a dangling membership still blocks the parent rather than disappearing.
 */
export function groupSubItemsByPair(memberships: MembershipRow[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const m of memberships) {
    const key = m.subItem
      ? `${m.subItem.fullTitle}::${m.subItem.trainingType}`
      : m.subItemTrainingTitle;
    groups.set(key, [...(groups.get(key) ?? []), m.subItemTrainingTitle]);
  }
  return groups;
}

/**
 * Recompute the parent OLX completion state for a student.
 *
 * For each parent in `parentTitles`:
 *  - If the student has a TrainingTaken row for every sub-item of the parent,
 *    materialise (or refresh) a TrainingTaken row on the parent. The parent's
 *    completedDate is the latest sub-item completion date; expiry is +2 years.
 *  - Otherwise, remove any existing materialised parent TrainingTaken row.
 *
 * Parents with zero sub-items are treated as "single-item OLX" — no automatic
 * parent row is materialised; users add the row directly.
 *
 * **"Every sub-item" means every `(fullTitle, trainingType)` GROUP, not every
 * `trainingTitle`.** A parent lists its sub-items as training titles, and
 * several of those routinely map to one Full Title — the different spellings a
 * course arrived under in an import. Requiring each *title* meant a parent
 * listing two spellings of one sub-item could only be completed by somebody who
 * had taken that course twice under both names: in practice, nobody. The rest of
 * the app has always counted on the pair (`resolveSiblingTitles`,
 * `training-group.ts:pairKey`, every report dedupe key), and the admin list page
 * already renders and counts these sub-items per Full Title — so the engine was
 * the odd one out.
 *
 * The change can only ever ADD a parent completion, never remove one: every
 * group is non-empty and their union is the full title list, so anything that
 * satisfied the old rule satisfies this one, and the branch that deletes a
 * materialised row is reachable only when the rule is NOT satisfied.
 */
export async function recomputeParentsForStudent(
  email: string,
  parentTitles: string[],
  client: Client = prisma,
): Promise<void> {
  if (parentTitles.length === 0) return;

  const parents = await client.trainingData.findMany({
    where: { trainingTitle: { in: parentTitles }, trainingType: "OLX" },
    // The nested select is what supplies the grouping key. Prisma batches it
    // across the whole parent set, so it costs one extra query for the call —
    // not one per parent. Do NOT move this lookup inside the loop below: that
    // loop is itself run once per student by `recomputeAllStudentsForParent`
    // and `recomputeParentsForMany`.
    include: {
      subItemMemberships: {
        include: { subItem: { select: { fullTitle: true, trainingType: true } } },
      },
    },
  });

  for (const parent of parents) {
    const subItemTitles = parent.subItemMemberships.map((m) => m.subItemTrainingTitle);

    // Single-item OLX (no sub-items defined) — nothing to materialise.
    if (subItemTitles.length === 0) continue;

    const groups = groupSubItemsByPair(parent.subItemMemberships);

    // Latest completion of each sub-item by this student.
    const taken = await client.trainingTaken.findMany({
      where: { email, trainingTitle: { in: subItemTitles } },
      orderBy: { completedDate: "desc" },
    });
    const latestBySubItem = new Map<string, Date>();
    for (const t of taken) {
      if (!latestBySubItem.has(t.trainingTitle)) {
        latestBySubItem.set(t.trainingTitle, t.completedDate);
      }
    }

    const allDone = [...groups.values()].every((titles) =>
      titles.some((t) => latestBySubItem.has(t)),
    );

    if (allDone) {
      // Parent completedDate = latest sub-item date, taken over EVERY held
      // sub-item rather than over one representative per group. That is
      // load-bearing: a per-group representative can be earlier than today's
      // answer, which would move `completedDate` backwards on a parent that is
      // already complete, shrink `expiryDate` with it, and let the sweep below
      // delete the original row — an OLX could flip from active to expired
      // purely from this refactor. Max-over-all equals max-over-group-maxima,
      // so leaving it alone is also what keeps an already-complete parent
      // byte-identical and unwritten.
      let latest = new Date(0);
      for (const d of latestBySubItem.values()) {
        if (d > latest) latest = d;
      }
      const expiry = computeExpiryDate(latest);

      const existing = await client.trainingTaken.findFirst({
        where: { email, trainingTitle: parent.trainingTitle },
        orderBy: { completedDate: "desc" },
      });

      if (!existing) {
        await client.trainingTaken.create({
          data: {
            email,
            trainingTitle: parent.trainingTitle,
            completedDate: latest,
            expiryDate: expiry,
          },
        });
      } else if (existing.completedDate.getTime() !== latest.getTime()) {
        await client.trainingTaken.update({
          where: { id: existing.id },
          data: { completedDate: latest, expiryDate: expiry },
        });
      }

      // Remove any spurious duplicate parent rows beyond the canonical one.
      await client.trainingTaken.deleteMany({
        where: {
          email,
          trainingTitle: parent.trainingTitle,
          NOT: { completedDate: latest },
        },
      });
    } else {
      // Student no longer has the full set — remove all materialised parent rows.
      await client.trainingTaken.deleteMany({
        where: { email, trainingTitle: parent.trainingTitle },
      });
    }
  }
}

/**
 * Given a sub-item training title, recompute every parent OLX that lists it
 * for the given student.
 */
export async function recomputeParentsForSubItem(
  email: string,
  subItemTrainingTitle: string,
  client: Client = prisma,
): Promise<void> {
  const memberships = await client.olxSubItemRelation.findMany({
    where: { subItemTrainingTitle },
    select: { parentTrainingTitle: true },
  });
  const parents = memberships.map((m) => m.parentTrainingTitle);
  await recomputeParentsForStudent(email, parents, client);
}

/**
 * After bulk operations (e.g. import), recompute parents for many (email,
 * subItem) pairs in one pass.
 */
export async function recomputeParentsForMany(
  pairs: { email: string; subItemTrainingTitle: string }[],
  client: Client = prisma,
): Promise<void> {
  if (pairs.length === 0) return;

  // Group by email and gather the unique parents implicated for that student.
  const subItems = Array.from(new Set(pairs.map((p) => p.subItemTrainingTitle)));
  const memberships = await client.olxSubItemRelation.findMany({
    where: { subItemTrainingTitle: { in: subItems } },
    select: { parentTrainingTitle: true, subItemTrainingTitle: true },
  });
  const parentsBySubItem = new Map<string, string[]>();
  for (const m of memberships) {
    const arr = parentsBySubItem.get(m.subItemTrainingTitle) ?? [];
    arr.push(m.parentTrainingTitle);
    parentsBySubItem.set(m.subItemTrainingTitle, arr);
  }

  const parentsByEmail = new Map<string, Set<string>>();
  for (const { email, subItemTrainingTitle } of pairs) {
    const parents = parentsBySubItem.get(subItemTrainingTitle);
    if (!parents) continue;
    const set = parentsByEmail.get(email) ?? new Set<string>();
    for (const p of parents) set.add(p);
    parentsByEmail.set(email, set);
  }

  for (const [email, parents] of parentsByEmail) {
    await recomputeParentsForStudent(email, Array.from(parents), client);
  }
}

/**
 * Recompute every parent OLX that contains the given sub-item, across all
 * students who have at least one taken row for that sub-item. Used when the
 * sub-item membership is added/removed from a parent.
 */
export async function recomputeAllStudentsForParent(
  parentTrainingTitle: string,
  client: Client = prisma,
): Promise<void> {
  const parent = await client.trainingData.findUnique({
    where: { trainingTitle: parentTrainingTitle },
    include: { subItemMemberships: true },
  });
  if (!parent || parent.trainingType !== "OLX") return;

  const subTitles = parent.subItemMemberships.map((m) => m.subItemTrainingTitle);

  // Collect every student with a sub-item row OR a stale parent row.
  const subTakers = subTitles.length === 0
    ? []
    : await client.trainingTaken.findMany({
        where: { trainingTitle: { in: subTitles } },
        select: { email: true },
        distinct: ["email"],
      });
  const parentTakers = await client.trainingTaken.findMany({
    where: { trainingTitle: parentTrainingTitle },
    select: { email: true },
    distinct: ["email"],
  });

  const emails = new Set<string>([
    ...subTakers.map((t) => t.email),
    ...parentTakers.map((t) => t.email),
  ]);

  for (const email of emails) {
    await recomputeParentsForStudent(email, [parentTrainingTitle], client);
  }
}

/**
 * Reconcile one training's OLX membership rows against a desired set.
 *
 * `subItems` is the parent-side list (meaningful when the row IS an OLX parent);
 * `parents` is the sub-item-side list (meaningful when the row IS an OLXSubItem).
 * Passing `undefined` for either leaves that side alone; passing an array makes
 * it authoritative.
 *
 * The `else` branches are load-bearing rather than tidy-up: a row that is no
 * longer an OLX parent must not keep parent-side relations, and likewise for the
 * sub-item side. That is why changing a training's type silently detaches its
 * memberships — it is meant to, and any caller that changes a type must expect
 * it.
 *
 * Returns the parent titles whose materialised completions are now stale.
 * Callers run `recomputeAllStudentsForParent` on each, OUTSIDE the transaction:
 * it is O(students x sub-items) sequential queries and is the only thing keeping
 * those parent `TrainingTaken` rows honest.
 *
 * Lifted out of `api/training-data/[title]/route.ts` so the group-level PATCH
 * shares it rather than growing a second copy that could drift.
 */
export async function syncMemberships(
  tx: PrismaTransactionClient,
  trainingTitle: string,
  trainingType: string,
  subItems: string[] | undefined,
  parents: string[] | undefined,
): Promise<{ affectedParents: string[] }> {
  const affectedParents = new Set<string>();

  if (trainingType === "OLX" && subItems) {
    const desired = new Set(subItems);
    const existing = await tx.olxSubItemRelation.findMany({
      where: { parentTrainingTitle: trainingTitle },
      select: { subItemTrainingTitle: true },
    });
    const existingSet = new Set(existing.map((e) => e.subItemTrainingTitle));
    const toAdd = [...desired].filter((s) => !existingSet.has(s));
    const toRemove = [...existingSet].filter((s) => !desired.has(s));
    if (toRemove.length > 0) {
      await tx.olxSubItemRelation.deleteMany({
        where: { parentTrainingTitle: trainingTitle, subItemTrainingTitle: { in: toRemove } },
      });
    }
    if (toAdd.length > 0) {
      await tx.olxSubItemRelation.createMany({
        data: toAdd.map((s) => ({ parentTrainingTitle: trainingTitle, subItemTrainingTitle: s })),
      });
    }
    if (toAdd.length > 0 || toRemove.length > 0) {
      affectedParents.add(trainingTitle);
    }
  } else if (trainingType !== "OLX") {
    // Not (or no longer) an OLX parent — drop any parent-side relations.
    const existing = await tx.olxSubItemRelation.findMany({
      where: { parentTrainingTitle: trainingTitle },
      select: { subItemTrainingTitle: true },
    });
    if (existing.length > 0) {
      await tx.olxSubItemRelation.deleteMany({
        where: { parentTrainingTitle: trainingTitle },
      });
      affectedParents.add(trainingTitle);
    }
  }

  if (trainingType === "OLXSubItem" && parents) {
    const desired = new Set(parents);
    const existing = await tx.olxSubItemRelation.findMany({
      where: { subItemTrainingTitle: trainingTitle },
      select: { parentTrainingTitle: true },
    });
    const existingSet = new Set(existing.map((e) => e.parentTrainingTitle));
    const toAdd = [...desired].filter((p) => !existingSet.has(p));
    const toRemove = [...existingSet].filter((p) => !desired.has(p));
    if (toRemove.length > 0) {
      await tx.olxSubItemRelation.deleteMany({
        where: { subItemTrainingTitle: trainingTitle, parentTrainingTitle: { in: toRemove } },
      });
      for (const p of toRemove) affectedParents.add(p);
    }
    if (toAdd.length > 0) {
      await tx.olxSubItemRelation.createMany({
        data: toAdd.map((p) => ({ parentTrainingTitle: p, subItemTrainingTitle: trainingTitle })),
      });
      for (const p of toAdd) affectedParents.add(p);
    }
  } else if (trainingType !== "OLXSubItem") {
    // Not (or no longer) an OLX sub-item — drop sub-item-side relations.
    const existing = await tx.olxSubItemRelation.findMany({
      where: { subItemTrainingTitle: trainingTitle },
      select: { parentTrainingTitle: true },
    });
    if (existing.length > 0) {
      await tx.olxSubItemRelation.deleteMany({
        where: { subItemTrainingTitle: trainingTitle },
      });
      for (const e of existing) affectedParents.add(e.parentTrainingTitle);
    }
  }

  return { affectedParents: [...affectedParents] };
}

/** A learner who has earned a parent OLX but has no materialised row for it. */
export type OlxOwedRow = {
  email: string;
  parentTrainingTitle: string;
  parentFullTitle: string;
};

/**
 * A learner holding a parent OLX row that the sub-item rule does not support.
 *
 * `subItemsHeld` / `subItemsRequired` count GROUPS, not training titles, and the
 * UI splits on them: holding some sub-items but not all means module data is
 * flowing for that learner and the missing one is genuinely missing (a stale
 * grant, safe to clear), whereas holding NONE suggests the parent row arrived as
 * a parent-title import with no module detail behind it — in which case it may
 * be the only record of a real completion, and clearing it cannot be undone
 * except by re-importing the module data. Nothing in the schema records where a
 * row came from, so this count is the only available proxy; the caller decides.
 */
export type OlxUnsupportedRow = OlxOwedRow & {
  subItemsHeld: number;
  subItemsRequired: number;
};

/**
 * Read-only reconciliation of every OLX parent against the completion rule.
 *
 * Materialisation is event-driven — a parent row is written only when something
 * touches that parent, a learner's sub-item completions, or an import runs — and
 * nothing else reconciles it. So a learner who already satisfied the rule when it
 * last changed never received their row, and will not until something unrelated
 * happens to touch them. This is what finds them.
 *
 * Writes nothing. It shares `groupSubItemsByPair` with the engine above, so the
 * preview and the fix are answering with the same definition.
 */
export async function scanOlxParentState(
  client: Client = prisma,
): Promise<{ owed: OlxOwedRow[]; unsupported: OlxUnsupportedRow[] }> {
  const parents = await client.trainingData.findMany({
    where: { trainingType: "OLX" },
    select: {
      trainingTitle: true,
      fullTitle: true,
      subItemMemberships: {
        select: {
          subItemTrainingTitle: true,
          subItem: { select: { fullTitle: true, trainingType: true } },
        },
      },
    },
  });

  // Parents with no sub-items are "single-item OLX": the rule never materialises
  // a row for them, so they can be neither owed nor unsupported.
  const withSubItems = parents.filter((p) => p.subItemMemberships.length > 0);
  if (withSubItems.length === 0) return { owed: [], unsupported: [] };

  const titles = new Set<string>();
  for (const p of withSubItems) {
    titles.add(p.trainingTitle);
    for (const m of p.subItemMemberships) titles.add(m.subItemTrainingTitle);
  }

  // One pass over the completions for every title involved, rather than a query
  // per parent per learner.
  const taken = await client.trainingTaken.findMany({
    where: { trainingTitle: { in: [...titles] } },
    select: { email: true, trainingTitle: true },
  });
  const heldByEmail = new Map<string, Set<string>>();
  for (const t of taken) {
    let held = heldByEmail.get(t.email);
    if (!held) {
      held = new Set<string>();
      heldByEmail.set(t.email, held);
    }
    held.add(t.trainingTitle);
  }

  const owed: OlxOwedRow[] = [];
  const unsupported: OlxUnsupportedRow[] = [];

  for (const parent of withSubItems) {
    const groups = [...groupSubItemsByPair(parent.subItemMemberships).values()];
    const subItemTitles = parent.subItemMemberships.map((m) => m.subItemTrainingTitle);

    for (const [email, held] of heldByEmail) {
      const hasParent = held.has(parent.trainingTitle);
      const touchesParent = hasParent || subItemTitles.some((t) => held.has(t));
      if (!touchesParent) continue;

      const groupsHeld = groups.filter((spellings) =>
        spellings.some((t) => held.has(t)),
      ).length;
      const allDone = groupsHeld === groups.length;

      if (allDone && !hasParent) {
        owed.push({
          email,
          parentTrainingTitle: parent.trainingTitle,
          parentFullTitle: parent.fullTitle,
        });
      } else if (!allDone && hasParent) {
        unsupported.push({
          email,
          parentTrainingTitle: parent.trainingTitle,
          parentFullTitle: parent.fullTitle,
          subItemsHeld: groupsHeld,
          subItemsRequired: groups.length,
        });
      }
    }
  }

  return { owed, unsupported };
}
