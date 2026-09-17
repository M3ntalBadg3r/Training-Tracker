import prisma from "@/lib/prisma";
import type { TrainingType } from "@prisma/client";
import { ELIGIBLE_TRAINING_DATA } from "@/lib/reportable-training";
import { resolveSiblingTitles } from "@/lib/program-compliance";

/**
 * The "leads to certification" graph, resolved at the level the app actually
 * counts on: `(fullTitle, trainingType)`.
 *
 * `certification[]` names the Certification(s) an ILT or OLX prepares people
 * for. It is stored per `trainingTitle`, but a `trainingTitle` is just the
 * spelling a training arrived under in an import — several routinely map to one
 * Full Title, and `resolveSiblingTitles` expands any of them to the whole
 * sibling group before counting holders.
 *
 * Reading `certification[]` per training title therefore got two things wrong,
 * in opposite directions:
 *
 *  - **False gaps.** The target certifications were matched by raw
 *    `trainingTitle`, so a learner holding a *sibling variant* of the required
 *    cert counted as not holding it at all.
 *  - **Missing gaps.** Until the admin UI made "leads to" a Full Title-level
 *    setting, it had to be filled in once per spelling. Any variant left blank
 *    was skipped outright by the `certification: { isEmpty: false }` filter, so
 *    its learners never appeared in the report.
 *
 * Both sides are resolved here, once, so the two Trained-But-Not-Certified
 * implementations (this module's callers) cannot drift on the rule itself.
 * They still differ in how they fetch completions — one per group, one batched
 * — which is deliberate and unaffected.
 */

export interface LeadsToGroup {
  /** `${fullTitle}::${trainingType}` — the identity everything downstream uses. */
  key: string;
  fullTitle: string;
  trainingType: TrainingType;
  productTypeName: string;
  /** Every catalogue title in this group: a completion of any one counts. */
  iltTitles: string[];
  /** Sibling-expanded target certifications: holding any one clears the gap. */
  certTitles: string[];
  /** The same targets as display names, for the "Missing Certification" column. */
  certFullTitles: string[];
}

const pairKey = (fullTitle: string, trainingType: string) => `${fullTitle}::${trainingType}`;

/**
 * Every ILT/OLX group that leads to at least one certification.
 *
 * Note the query does NOT filter on `certification: { isEmpty: false }`: that
 * would drop a variant before its siblings could supply the value. The union is
 * taken per group and empty groups are dropped afterwards.
 */
export async function fetchLeadsToGroups(): Promise<LeadsToGroup[]> {
  const rows = await prisma.trainingData.findMany({
    where: {
      ...ELIGIBLE_TRAINING_DATA,
      trainingType: { in: ["InstructorLedTraining", "OLX"] },
    },
    select: {
      trainingTitle: true,
      fullTitle: true,
      trainingType: true,
      certification: true,
      productType: { select: { name: true } },
    },
  });
  if (rows.length === 0) return [];

  const byPair = new Map<
    string,
    {
      fullTitle: string;
      trainingType: TrainingType;
      productTypeName: string;
      iltTitles: string[];
      certs: Set<string>;
    }
  >();
  for (const r of rows) {
    const key = pairKey(r.fullTitle, r.trainingType);
    let entry = byPair.get(key);
    if (!entry) {
      entry = {
        fullTitle: r.fullTitle,
        trainingType: r.trainingType,
        productTypeName: r.productType.name,
        iltTitles: [],
        certs: new Set<string>(),
      };
      byPair.set(key, entry);
    }
    entry.iltTitles.push(r.trainingTitle);
    for (const c of r.certification) entry.certs.add(c);
  }

  // Drop groups that lead nowhere, then expand the targets to their sibling
  // groups in one round-trip for the whole report.
  const populated = Array.from(byPair.entries()).filter(([, e]) => e.certs.size > 0);
  if (populated.length === 0) return [];

  const allCertTitles = Array.from(
    new Set(populated.flatMap(([, e]) => Array.from(e.certs))),
  );
  const { fetchTitles, groupMembers } = await resolveSiblingTitles(allCertTitles);

  const fullTitleOf = new Map<string, string>();
  if (fetchTitles.length > 0) {
    const certRows = await prisma.trainingData.findMany({
      where: { trainingTitle: { in: fetchTitles } },
      select: { trainingTitle: true, fullTitle: true },
    });
    for (const c of certRows) fullTitleOf.set(c.trainingTitle, c.fullTitle);
  }

  return populated.map(([key, e]) => {
    const expanded = new Set<string>();
    for (const c of e.certs) {
      // A configured title with no catalogue row keeps itself, matching
      // `resolveSiblingTitles`' own singleton fallback — a dangling reference
      // should not quietly widen or narrow the match.
      for (const m of groupMembers.get(c) ?? [c]) expanded.add(m);
    }
    const certTitles = Array.from(expanded);
    return {
      key,
      fullTitle: e.fullTitle,
      trainingType: e.trainingType,
      productTypeName: e.productTypeName,
      iltTitles: e.iltTitles,
      certTitles,
      // Display names come from the ORIGINAL configured targets, not the
      // expansion: siblings share a Full Title, so expanding first would just
      // produce the same names, and an unresolvable title is shown as its raw
      // key rather than dropped.
      certFullTitles: Array.from(
        new Set(Array.from(e.certs).map((c) => fullTitleOf.get(c) ?? c)),
      ).sort((a, b) => a.localeCompare(b)),
    };
  });
}
