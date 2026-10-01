import prisma from "@/lib/prisma";
import { fetchLeadsToGroups } from "@/lib/leads-to";
import { getEmailSetsByTitle, type ComplianceScope } from "@/lib/program-compliance";

/**
 * "Trained not certified" for the program dashboard: the people in a view's
 * population who hold a currently-valid ILT/OLX that **leads to** a
 * requirement's certification, but do not currently hold that certification.
 *
 * The rule, and why it is this rule:
 *
 *  - **Population** — exactly the scope the requirement's Attained figure is
 *    counted over (country / the region's or set's countries / theatre, plus the
 *    company scope). The figure is the complement of Attained within the trained
 *    pool, so the two must be counted over the same people.
 *  - **Trained** — an active completion (`completedDate <= now < expiryDate`,
 *    the `getEmailSetsByTitle` point-in-time rule) of any ILT/OLX whose
 *    `certification[]` names one of the requirement's Certification titles.
 *    "Leads to" is resolved per `(fullTitle, trainingType)` group with sibling
 *    expansion on both sides by `lib/leads-to.ts:fetchLeadsToGroups`, the same
 *    graph the Trained-But-Not-Certified report uses. An expired ILT does not
 *    count: the preparation is stale.
 *  - **Not certified** — not in the requirement's Attained set: no active
 *    completion of the primary training or any alternative (sibling-expanded).
 *    A lapsed certification therefore still counts as "not certified".
 *  - **Certification requirements only.** `certification[]` can only target a
 *    Certification, so an Accreditation/ILT/OLX requirement has no trained pool
 *    to report and the field is left absent on it. A Certification requirement's
 *    alternatives that are themselves Certifications contribute their leads-to
 *    trainings too.
 *
 * This deliberately mirrors Compliance Planning's "easy-win" candidate tier
 * (`lib/compliance-plan.ts`: holds an ILT/OLX that leads to the cert, not the
 * cert), so the dashboard's opportunity figure and the planner's cheapest
 * candidates are the same people.
 *
 * Always counted at "now": under a projection horizon the dashboard still shows
 * today's figure, labelled as such.
 */

/** The minimal requirement shape the rule needs. */
export interface TncRequirement {
  trainingType: string | null;
  trainingTitle: string | null;
  alternatives: { trainingType: string; trainingTitle: string }[];
}

/** The report-wide data the per-requirement figure is computed from. */
export interface TrainedNotCertifiedContext {
  /** Certification trainingTitle → the ILT/OLX titles that lead to it. */
  iltByCert: Map<string, Set<string>>;
  /** Active holders of each leads-to ILT/OLX title, over the view's population. */
  iltEmailSets: Map<string, Set<string>>;
}

/** Whether the requirement is one the figure applies to. */
export function isTncRequirement(req: TncRequirement): boolean {
  return req.trainingType === "Certification" && !!req.trainingTitle;
}

/**
 * The Certification titles of a requirement whose leads-to trainings form its
 * trained pool: the primary (itself a Certification, see `isTncRequirement`)
 * plus every alternative that is a Certification.
 */
export function certTitlesOf(req: TncRequirement): string[] {
  if (!isTncRequirement(req)) return [];
  const out = new Set<string>([req.trainingTitle!]);
  for (const a of req.alternatives) {
    if (a.trainingType === "Certification") out.add(a.trainingTitle);
  }
  return [...out];
}

/**
 * Certification title → leads-to ILT/OLX titles. `fetchLeadsToGroups` has
 * already expanded each group's targets to their sibling groups, so a
 * requirement naming any catalogue variant of the cert finds its trainings.
 */
async function buildLeadsToIndex(): Promise<Map<string, Set<string>>> {
  const groups = await fetchLeadsToGroups();
  const index = new Map<string, Set<string>>();
  for (const g of groups) {
    for (const c of g.certTitles) {
      let set = index.get(c);
      if (!set) {
        set = new Set();
        index.set(c, set);
      }
      for (const t of g.iltTitles) set.add(t);
    }
  }
  return index;
}

function iltTitlesFor(certTitles: string[], index: Map<string, Set<string>>): string[] {
  const out = new Set<string>();
  for (const c of certTitles) for (const t of index.get(c) ?? []) out.add(t);
  return [...out];
}

/**
 * Build the report-wide context for one view: the leads-to graph, fetched once,
 * and the active holders of every relevant ILT/OLX in ONE query over the view's
 * scope. Returns null when no requirement in the view is a Certification, so a
 * view without one does no extra work and its rows carry no field.
 *
 * `hasArea: false` (an empty region or set) skips the holder query — `in: []`
 * would match nobody anyway.
 */
export async function buildTrainedNotCertifiedContext(
  reqs: TncRequirement[],
  now: Date,
  scope: ComplianceScope,
  hasArea = true
): Promise<TrainedNotCertifiedContext | null> {
  const certTitles = [...new Set(reqs.flatMap(certTitlesOf))];
  if (certTitles.length === 0) return null;
  const iltByCert = await buildLeadsToIndex();
  const iltTitles = iltTitlesFor(certTitles, iltByCert);
  const iltEmailSets =
    hasArea && iltTitles.length > 0
      ? await getEmailSetsByTitle(iltTitles, now, scope)
      : new Map<string, Set<string>>();
  return { iltByCert, iltEmailSets };
}

/**
 * The trained-not-certified people for one requirement: the active holders of
 * its leads-to trainings, minus its Attained set (`certifiedEmailSets` is the
 * very map the requirement's Attained figure was counted from, so the two
 * cannot disagree about who is certified).
 */
export function trainedNotCertifiedEmails(
  req: TncRequirement,
  ctx: TrainedNotCertifiedContext,
  certifiedEmailSets: Map<string, Set<string>>
): Set<string> {
  const certified = new Set<string>();
  if (req.trainingTitle) {
    for (const t of [req.trainingTitle, ...req.alternatives.map((a) => a.trainingTitle)]) {
      for (const e of certifiedEmailSets.get(t) ?? []) certified.add(e);
    }
  }
  const out = new Set<string>();
  for (const t of iltTitlesFor(certTitlesOf(req), ctx.iltByCert)) {
    for (const e of ctx.iltEmailSets.get(t) ?? []) {
      if (!certified.has(e)) out.add(e);
    }
  }
  return out;
}

export interface TrainedNotCertifiedRosterRow {
  fullName: string;
  email: string;
  country: string;
  theatre: string;
  /** The leads-to ILT/OLX this person holds (the latest, if several). */
  completedDate: string;
  expiryDate: string;
  training: string;
}

/**
 * Roster drill-down for the figure. `trainingTitles` are the requirement's
 * titles as the holder roster receives them (primary, then alternatives): the
 * Certification-typed ones supply the leads-to trainings, and holding ANY of
 * them (sibling-expanded) excludes a person — the same rule the count applies,
 * so the list a user opens matches the number they clicked.
 *
 * `scope` must be the same `ComplianceScope` the report counted over; the
 * caller resolves it (`resolveRosterScope` in `program-report.ts`).
 */
export async function getTrainedNotCertifiedRoster(
  trainingTitles: string[],
  scope: ComplianceScope,
  hasArea = true
): Promise<{ students: TrainedNotCertifiedRosterRow[] }> {
  if (trainingTitles.length === 0 || !hasArea) return { students: [] };
  if (Array.isArray(scope.companyIds) && scope.companyIds.length === 0) return { students: [] };
  const now = new Date();

  const typed = await prisma.trainingData.findMany({
    where: { trainingTitle: { in: trainingTitles } },
    select: { trainingTitle: true, trainingType: true },
  });
  const certTitles = typed.filter((t) => t.trainingType === "Certification").map((t) => t.trainingTitle);
  if (certTitles.length === 0) return { students: [] };

  const iltTitles = iltTitlesFor(certTitles, await buildLeadsToIndex());
  if (iltTitles.length === 0) return { students: [] };

  const [certifiedSets, iltSets] = await Promise.all([
    getEmailSetsByTitle(trainingTitles, now, scope),
    getEmailSetsByTitle(iltTitles, now, scope),
  ]);
  const certified = new Set<string>();
  for (const s of certifiedSets.values()) for (const e of s) certified.add(e);
  const emails = new Set<string>();
  for (const s of iltSets.values()) for (const e of s) if (!certified.has(e)) emails.add(e);
  if (emails.size === 0) return { students: [] };

  // The emails are already confined to the scope by the holder query above, so
  // this lookup needs no student filter — it only fetches the rows to show.
  // `iltTitles` are whole (fullTitle, trainingType) groups from the leads-to
  // graph, so every sibling variant a person may hold is already in the list.
  const records = await prisma.trainingTaken.findMany({
    where: {
      email: { in: [...emails] },
      trainingTitle: { in: iltTitles },
      completedDate: { lte: now },
      expiryDate: { gt: now },
    },
    include: {
      student: { select: { fullName: true, email: true, country: true, theatre: true } },
      trainingData: { select: { fullTitle: true } },
    },
  });

  const latest = new Map<string, (typeof records)[number]>();
  for (const r of records) {
    const existing = latest.get(r.email);
    if (!existing || r.completedDate > existing.completedDate) latest.set(r.email, r);
  }

  const students = [...latest.values()]
    .map((r) => ({
      fullName: r.student.fullName,
      email: r.email,
      country: r.student.country,
      theatre: r.student.theatre,
      completedDate: r.completedDate.toISOString().split("T")[0],
      expiryDate: r.expiryDate.toISOString().split("T")[0],
      training: r.trainingData?.fullTitle ?? r.trainingTitle,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { students };
}
