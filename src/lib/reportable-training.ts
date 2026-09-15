/**
 * Which catalogue rows may appear in reporting.
 *
 * A student import auto-creates a `TrainingData` row for any training title it
 * doesn't recognise. The three classification columns are NOT NULL, so it has
 * to write *something* — always `Certification`, always `Sales`, and whichever
 * product type sorts first — and flags the row `isIncomplete: true` to record
 * that nobody has actually chosen those values yet (see the auto-create in
 * `api/import/route.ts` and the "needs attention" table on
 * `/admin/training-data`).
 *
 * Those placeholders must never reach a report. The completions attached to
 * such a row are real, but its Type/Product/Function are invented, so counting
 * it files real numbers under a category no one picked — inflating
 * certification counts and skewing every by-type/product/function breakdown.
 *
 * An admin can also mark an entry as not needed (`isIgnored`), which excludes
 * it for a different reason with the same consequence. Neither kind contributes
 * anything to reports, the dashboard, exports or the public API, and either
 * reappears everywhere the moment its flag clears.
 *
 * These constants exist because the completion query is duplicated across four
 * modules (see the note at the top of `training-records-query.ts`). Sharing the
 * predicate is what stops a future edit from adding the guard to one copy and
 * not the others — grep for the constant to find every reporting read.
 */

import type { Prisma } from "@prisma/client";

/**
 * Catalogue rows eligible to appear in reporting. Two ways a row drops out, for
 * opposite reasons but with the same consequence:
 *
 * - `isIncomplete` — an import auto-created it and nobody has classified it yet,
 *   so its Type/Product/Function are placeholders (above).
 * - `isIgnored` — an admin has explicitly marked it as not needed.
 *
 * Either way its completions are real but it must not be counted, so neither
 * kind reaches a report. Both reappear the moment the flag clears.
 */
export const ELIGIBLE_TRAINING_DATA = {
  isIncomplete: false,
  isIgnored: false,
} satisfies Prisma.TrainingDataWhereInput;

/**
 * The relation filter for completion-counting reads: eligible rows only, and
 * no OLX sub-items (those aren't stand-alone completions — they roll up into
 * the parent OLX, so counting both double-counts).
 */
export const REPORTABLE_TRAINING_DATA = {
  ...ELIGIBLE_TRAINING_DATA,
  trainingType: { not: "OLXSubItem" },
} satisfies Prisma.TrainingDataWhereInput;
