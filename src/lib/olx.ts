import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
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
 * over, and it is shared by the engine (`loadParentDefs` → `planOne`) and the
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
 * Size of every `in` list the engine sends. Postgres has no hard limit short of
 * the 65,535 bind-parameter ceiling, but a few thousand values per list keeps
 * each statement's plan and payload modest over a remote connection.
 */
const IN_CHUNK = 5_000;

/**
 * How many learners are evaluated and written per pass. Each pass is: one
 * completion read, then at most a handful of bulk writes. A failure part-way
 * through therefore leaves every earlier pass fully applied and every later one
 * untouched — the same "a prefix of learners is done" shape the per-learner
 * loop it replaced left behind.
 */
const LEARNER_CHUNK = 5_000;

/** Rows per `UPDATE … FROM (VALUES …)` statement (3 bind parameters each). */
const UPDATE_CHUNK = 1_000;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One OLX parent, with its sub-items resolved into the groups the rule counts. */
type ParentDef = {
  trainingTitle: string;
  subItemTitles: string[];
  groups: string[][];
};

/** The slice of a completion row the rule reads. */
type TakenRow = { id: number; email: string; trainingTitle: string; completedDate: Date };

/**
 * Load the OLX parents among `titles`, in the order the database returns them.
 *
 * The nested select is what supplies the grouping key. Prisma batches it across
 * the whole parent set, so it costs one extra query per chunk of parents — not
 * one per parent, and (now that this runs once per CALL rather than once per
 * learner) not one per learner either. Do NOT move it inside a per-parent or
 * per-learner loop.
 */
async function loadParentDefs(titles: string[], client: Client): Promise<ParentDef[]> {
  const defs: ParentDef[] = [];
  for (const part of chunk(titles, IN_CHUNK)) {
    const parents = await client.trainingData.findMany({
      where: { trainingTitle: { in: part }, trainingType: "OLX" },
      include: {
        subItemMemberships: {
          include: { subItem: { select: { fullTitle: true, trainingType: true } } },
        },
      },
    });
    for (const parent of parents) {
      defs.push({
        trainingTitle: parent.trainingTitle,
        subItemTitles: parent.subItemMemberships.map((m) => m.subItemTrainingTitle),
        // The single definition of "every sub-item" — shared with the scan.
        groups: [...groupSubItemsByPair(parent.subItemMemberships).values()],
      });
    }
  }
  return defs;
}

/**
 * The pending writes for one pass. `creates` keeps learner-then-parent order,
 * which is the order the per-learner loop created rows in, so autoincrement ids
 * are handed out in the same sequence.
 */
type Plan = {
  creates: { email: string; trainingTitle: string; completedDate: Date; expiryDate: Date }[];
  updates: { id: number; completedDate: Date; expiryDate: Date }[];
  deletes: number[];
};

/**
 * Apply the completion rule to one (learner, parent), reading only the
 * in-memory snapshot of that learner's rows, and record the writes it implies.
 *
 * This is the body of the old per-learner loop with every query replaced by a
 * lookup, and it must keep making exactly the same decisions:
 *
 *  - "done" means every `(fullTitle, trainingType)` GROUP has at least one held
 *    spelling (see `recomputeParentsForStudent`);
 *  - `latest` is the max completion date over EVERY held sub-item row, never one
 *    representative per group, seeded at the epoch exactly as before;
 *  - the canonical parent row is the one with the latest `completedDate`; it is
 *    rewritten only when its date differs from `latest` — so an already-complete
 *    parent is left byte-identical and unwritten — and every OTHER parent row
 *    whose date differs from `latest` is swept (rows already AT `latest` survive,
 *    exactly as the old `NOT: { completedDate: latest }` delete left them);
 *  - when the rule does not hold, every parent row for the learner goes.
 *
 * On a tie for the latest parent row the old `findFirst` let Postgres choose;
 * this picks the lowest id. The tied rows share a date, so the only observable
 * difference is which of two otherwise-identical ids survives the sweep.
 */
function planOne(
  email: string,
  parent: ParentDef,
  byTitle: Map<string, TakenRow[]> | undefined,
  plan: Plan,
): void {
  const held = new Set<string>();
  let latest = new Date(0);
  for (const title of parent.subItemTitles) {
    const rows = byTitle?.get(title);
    if (!rows || rows.length === 0) continue;
    held.add(title);
    for (const r of rows) {
      if (r.completedDate > latest) latest = r.completedDate;
    }
  }

  const parentRows = byTitle?.get(parent.trainingTitle) ?? [];
  const allDone = parent.groups.every((titles) => titles.some((t) => held.has(t)));

  if (!allDone) {
    for (const r of parentRows) plan.deletes.push(r.id);
    return;
  }

  const expiry = computeExpiryDate(latest);
  if (parentRows.length === 0) {
    plan.creates.push({
      email,
      trainingTitle: parent.trainingTitle,
      completedDate: latest,
      expiryDate: expiry,
    });
    return;
  }

  let existing = parentRows[0];
  for (const r of parentRows) {
    const d = r.completedDate.getTime();
    const e = existing.completedDate.getTime();
    if (d > e || (d === e && r.id < existing.id)) existing = r;
  }
  if (existing.completedDate.getTime() !== latest.getTime()) {
    plan.updates.push({ id: existing.id, completedDate: latest, expiryDate: expiry });
  }
  for (const r of parentRows) {
    if (r !== existing && r.completedDate.getTime() !== latest.getTime()) {
      plan.deletes.push(r.id);
    }
  }
}

async function applyPlan(plan: Plan, client: Client): Promise<void> {
  for (const part of chunk(plan.creates, IN_CHUNK)) {
    await client.trainingTaken.createMany({ data: part });
  }
  // Each update carries its own dates, so it is one VALUES list per chunk rather
  // than one statement per row. Dates go in as ISO-8601 text cast to
  // `timestamp(3)`: Prisma stores DateTime as UTC in a zone-less column, and a
  // cast to `timestamp` ignores the trailing `Z`, which is exactly that mapping.
  for (const part of chunk(plan.updates, UPDATE_CHUNK)) {
    const values = Prisma.join(
      part.map(
        (u) =>
          Prisma.sql`(${u.id}::int, ${u.completedDate.toISOString()}::timestamp(3), ${u.expiryDate.toISOString()}::timestamp(3))`,
      ),
    );
    await client.$executeRaw(Prisma.sql`
      UPDATE training_taken AS t
         SET completed_date = v.completed_date,
             expiry_date = v.expiry_date
        FROM (VALUES ${values}) AS v(id, completed_date, expiry_date)
       WHERE t.id = v.id
    `);
  }
  for (const part of chunk(plan.deletes, IN_CHUNK)) {
    await client.trainingTaken.deleteMany({ where: { id: { in: part } } });
  }
}

/**
 * The batched core every public entry point runs through.
 *
 * `work` is an ordered list of (learner, parent titles to recompute). Round
 * trips scale with chunks, not learners: the parents are loaded once, then per
 * {@link LEARNER_CHUNK} learners there is one completion read and at most a few
 * bulk writes. The rule itself is evaluated in memory by {@link planOne}.
 */
async function recomputeBatch(
  work: [email: string, parentTitles: Iterable<string>][],
  client: Client,
): Promise<void> {
  if (work.length === 0) return;

  const requested = new Set<string>();
  for (const [, titles] of work) for (const t of titles) requested.add(t);
  if (requested.size === 0) return;

  const defs = await loadParentDefs([...requested], client);
  // Single-item OLX (no sub-items defined) — nothing to materialise or remove.
  const active = defs.filter((d) => d.subItemTitles.length > 0);
  if (active.length === 0) return;

  // Evaluating from one snapshot is only equivalent to the old sequential loop
  // when no parent being written is also read as somebody's sub-item: then one
  // parent's writes could change another parent's answer for the same learner,
  // and the outcome would depend on processing order. The catalogue does not
  // produce this (sub-items are OLXSubItem rows), but membership rows are not
  // type-checked, so if it ever appears fall back to the original per-learner
  // path rather than guess.
  const written = new Set(active.map((d) => d.trainingTitle));
  if (active.some((d) => d.subItemTitles.some((t) => written.has(t)))) {
    for (const [email, titles] of work) {
      await recomputeParentsForStudentSequential(email, [...titles], client);
    }
    return;
  }

  const order = new Map(active.map((d, i) => [d.trainingTitle, i]));
  const titlesToLoad = new Set<string>();
  for (const d of active) {
    titlesToLoad.add(d.trainingTitle);
    for (const t of d.subItemTitles) titlesToLoad.add(t);
  }
  const titleChunks = chunk([...titlesToLoad], IN_CHUNK);

  // Merge repeated learners (keeping first-seen order) so each is evaluated once.
  const byEmail = new Map<string, Set<string>>();
  for (const [email, titles] of work) {
    let set = byEmail.get(email);
    if (!set) {
      set = new Set<string>();
      byEmail.set(email, set);
    }
    for (const t of titles) if (order.has(t)) set.add(t);
  }
  const learners = [...byEmail].filter(([, set]) => set.size > 0);

  for (const learnerPart of chunk(learners, LEARNER_CHUNK)) {
    const emails = learnerPart.map(([email]) => email);
    const rowsByEmail = new Map<string, Map<string, TakenRow[]>>();
    for (const emailPart of chunk(emails, IN_CHUNK)) {
      for (const titlePart of titleChunks) {
        const rows = await client.trainingTaken.findMany({
          where: { email: { in: emailPart }, trainingTitle: { in: titlePart } },
          select: { id: true, email: true, trainingTitle: true, completedDate: true },
        });
        for (const r of rows) {
          let byTitle = rowsByEmail.get(r.email);
          if (!byTitle) {
            byTitle = new Map();
            rowsByEmail.set(r.email, byTitle);
          }
          const list = byTitle.get(r.trainingTitle);
          if (list) list.push(r);
          else byTitle.set(r.trainingTitle, [r]);
        }
      }
    }

    const plan: Plan = { creates: [], updates: [], deletes: [] };
    for (const [email, titles] of learnerPart) {
      // Parents in the order the parent query returned them — the order the
      // old per-learner loop walked them in.
      const mine = [...titles].sort((a, b) => order.get(a)! - order.get(b)!);
      for (const title of mine) {
        planOne(email, active[order.get(title)!], rowsByEmail.get(email), plan);
      }
    }
    await applyPlan(plan, client);
  }
}

/**
 * The original one-learner-at-a-time implementation, kept verbatim as the
 * fallback for the nested-membership case {@link recomputeBatch} declines to
 * evaluate from a snapshot. Not used on any ordinary catalogue.
 */
async function recomputeParentsForStudentSequential(
  email: string,
  parentTitles: string[],
  client: Client,
): Promise<void> {
  if (parentTitles.length === 0) return;

  const parents = await client.trainingData.findMany({
    where: { trainingTitle: { in: parentTitles }, trainingType: "OLX" },
    include: {
      subItemMemberships: {
        include: { subItem: { select: { fullTitle: true, trainingType: true } } },
      },
    },
  });

  for (const parent of parents) {
    const subItemTitles = parent.subItemMemberships.map((m) => m.subItemTrainingTitle);
    if (subItemTitles.length === 0) continue;

    const groups = groupSubItemsByPair(parent.subItemMemberships);

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

      await client.trainingTaken.deleteMany({
        where: {
          email,
          trainingTitle: parent.trainingTitle,
          NOT: { completedDate: latest },
        },
      });
    } else {
      await client.trainingTaken.deleteMany({
        where: { email, trainingTitle: parent.trainingTitle },
      });
    }
  }
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
 *
 * Delegates to the batched core, so a single learner costs a fixed handful of
 * queries however many parents are named, rather than ~4 per parent.
 */
export async function recomputeParentsForStudent(
  email: string,
  parentTitles: string[],
  client: Client = prisma,
): Promise<void> {
  if (parentTitles.length === 0) return;
  await recomputeBatch([[email, parentTitles]], client);
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
 * subItem) pairs in one pass. Round trips scale with chunks of learners, not
 * with learners — see {@link recomputeBatch}.
 */
export async function recomputeParentsForMany(
  pairs: { email: string; subItemTrainingTitle: string }[],
  client: Client = prisma,
): Promise<void> {
  if (pairs.length === 0) return;

  const subItems = Array.from(new Set(pairs.map((p) => p.subItemTrainingTitle)));
  const parentsBySubItem = new Map<string, string[]>();
  for (const part of chunk(subItems, IN_CHUNK)) {
    const memberships = await client.olxSubItemRelation.findMany({
      where: { subItemTrainingTitle: { in: part } },
      select: { parentTrainingTitle: true, subItemTrainingTitle: true },
    });
    for (const m of memberships) {
      const arr = parentsBySubItem.get(m.subItemTrainingTitle) ?? [];
      arr.push(m.parentTrainingTitle);
      parentsBySubItem.set(m.subItemTrainingTitle, arr);
    }
  }

  // Group by email (first-seen order) and gather the parents implicated.
  const parentsByEmail = new Map<string, Set<string>>();
  for (const { email, subItemTrainingTitle } of pairs) {
    const parents = parentsBySubItem.get(subItemTrainingTitle);
    if (!parents) continue;
    const set = parentsByEmail.get(email) ?? new Set<string>();
    for (const p of parents) set.add(p);
    parentsByEmail.set(email, set);
  }

  await recomputeBatch([...parentsByEmail], client);
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
  // A parent with no sub-items is a single-item OLX: the rule neither writes
  // nor removes a row for any learner, so there is nobody to visit.
  if (subTitles.length === 0) return;

  // Collect every student with a sub-item row OR a stale parent row.
  const subTakers = await client.trainingTaken.findMany({
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

  await recomputeBatch(
    [...emails].map((email) => [email, [parentTrainingTitle]]),
    client,
  );
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
 * it visits every learner holding the parent or any of its sub-items (batched,
 * a few queries per few thousand learners) and is the only thing keeping those
 * parent `TrainingTaken` rows honest.
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
