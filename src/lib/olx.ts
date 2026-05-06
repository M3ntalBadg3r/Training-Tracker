import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { computeExpiryDate } from "@/lib/utils";

type Client = typeof prisma | PrismaTransactionClient;

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
 */
export async function recomputeParentsForStudent(
  email: string,
  parentTitles: string[],
  client: Client = prisma,
): Promise<void> {
  if (parentTitles.length === 0) return;

  const parents = await client.trainingData.findMany({
    where: { trainingTitle: { in: parentTitles }, trainingType: "OLX" },
    include: { subItemMemberships: true },
  });

  for (const parent of parents) {
    const subItemTitles = parent.subItemMemberships.map((m) => m.subItemTrainingTitle);

    // Single-item OLX (no sub-items defined) — nothing to materialise.
    if (subItemTitles.length === 0) continue;

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

    const allDone = subItemTitles.every((t) => latestBySubItem.has(t));

    if (allDone) {
      // Parent completedDate = latest sub-item date.
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
