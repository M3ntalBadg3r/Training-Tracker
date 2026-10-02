/**
 * Shared row shape for the program dashboard's "View" rosters — the holders of
 * a requirement (`program-report.ts:getProgramStudents`) and the people behind
 * its "Trained not certified" figure
 * (`program-trained-not-certified.ts:getTrainedNotCertifiedRoster`).
 *
 * One row per person, as before, but every training that qualified them is
 * listed in `holdings`. Both rosters used to keep only the person's single most
 * recent matching completion, and the dashboard's modal groups people by
 * training — so somebody holding two of the matching trainings was filed under
 * whichever they took last and silently missing from the other's table. The
 * modal's per-training counts then disagreed with the Trained-But-Not-Certified
 * report filtered to one training (that report keys on the training, so it
 * counts such a person under each), while the figure itself was right.
 *
 * The top-level `training`/`completedDate`/`expiryDate` stay the latest holding
 * so the public API's existing fields keep their meaning; `holdings` is
 * additive.
 */

export interface RosterHolding {
  /** The training's Full Title — sibling variants of one training merge here. */
  training: string;
  /** Latest completion of this training, ISO `yyyy-mm-dd`. */
  completedDate: string;
  expiryDate: string;
}

export interface RosterRow {
  fullName: string;
  email: string;
  country: string;
  theatre: string;
  /** The latest of `holdings`, kept for existing consumers. */
  completedDate: string;
  expiryDate: string;
  training: string;
  /** Every matching training this person holds, latest first. */
  holdings: RosterHolding[];
}

export interface RosterRecord {
  email: string;
  trainingTitle: string;
  completedDate: Date;
  expiryDate: Date;
  student: { fullName: string; country: string; theatre: string };
  trainingData: { fullTitle: string } | null;
}

const isoDate = (d: Date) => d.toISOString().split("T")[0];

/** Fold completion records into one row per person, sorted by name. */
export function toRosterRows(records: RosterRecord[]): RosterRow[] {
  const byEmail = new Map<string, { student: RosterRecord["student"]; latest: Map<string, RosterRecord> }>();
  for (const r of records) {
    let entry = byEmail.get(r.email);
    if (!entry) {
      entry = { student: r.student, latest: new Map() };
      byEmail.set(r.email, entry);
    }
    const training = r.trainingData?.fullTitle ?? r.trainingTitle;
    const existing = entry.latest.get(training);
    if (!existing || r.completedDate > existing.completedDate) entry.latest.set(training, r);
  }

  const rows: RosterRow[] = [];
  for (const [email, { student, latest }] of byEmail) {
    const holdings = [...latest.entries()]
      .sort((a, b) => b[1].completedDate.getTime() - a[1].completedDate.getTime() || a[0].localeCompare(b[0]))
      .map(([training, r]) => ({
        training,
        completedDate: isoDate(r.completedDate),
        expiryDate: isoDate(r.expiryDate),
      }));
    const top = holdings[0];
    rows.push({
      fullName: student.fullName,
      email,
      country: student.country,
      theatre: student.theatre,
      completedDate: top.completedDate,
      expiryDate: top.expiryDate,
      training: top.training,
      holdings,
    });
  }
  return rows.sort((a, b) => a.fullName.localeCompare(b.fullName));
}
