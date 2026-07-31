import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { invalidateReportCache } from "@/lib/report-cache";
import { titleCaseName, deriveNameFromEmail } from "@/lib/utils";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBERS_REGEX = /[0-9]/;
// Allow letters (any script), combining marks, spaces, hyphens, and apostrophes —
// periods are flagged; digits excluded (covered by NUMBERS_REGEX).
//
// INVARIANT: fixName's output must never contain a character this rejects, or the
// scanner re-flags its own suggested fix on the next scan. Keep in lockstep with
// NAME_DISALLOWED in lib/utils.ts, the strip inside fixName, hasDuplicateWord's
// normaliser, and the highlighter regex in admin/cleanup/page.tsx.
const SPECIAL_CHARS_REGEX = /[^\p{L}\p{M}\s\-'\d]/u;
// Matches a name composed solely of question marks and whitespace, with at least one '?'
const QUESTION_MARKS_REGEX = /^[\s?]*\?[\s?]*$/;
/** Student.fullName is an unbounded String and this is a free-text field. */
const MAX_NAME_LENGTH = 200;

function detectIssues(fullName: string): string[] {
  const issues: string[] = [];
  // Also catches internal double-spaces, which the import used to write and which
  // nothing could previously detect.
  if (fullName !== fullName.trim().replace(/\s+/g, " ")) issues.push("leading_trailing_spaces");
  if (EMAIL_REGEX.test(fullName.trim())) issues.push("email_as_name");
  if (QUESTION_MARKS_REGEX.test(fullName.trim())) issues.push("question_marks");
  if (hasDuplicateWord(fullName)) issues.push("duplicate_name");
  if (NUMBERS_REGEX.test(fullName)) issues.push("numbers");
  if (SPECIAL_CHARS_REGEX.test(fullName) && !EMAIL_REGEX.test(fullName.trim())) {
    issues.push("special_characters");
  }
  return issues;
}

function hasDuplicateWord(fullName: string): boolean {
  // Normalize the way fixName does so duplicates emerging after cleanup are also detected
  // (e.g. "Jane Jane.doe" — the dot is later replaced with a space, exposing the duplicate)
  const normalized = fullName
    .trim()
    .toLowerCase()
    .replace(/[0-9]/g, "")
    .replace(/\./g, " ")
    .replace(/[^\p{L}\p{M}\s\-']/gu, "");
  const words = normalized.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  for (const w of words) {
    // Initials repeat legitimately ("J R R Smith") — must match dedupeWords, or a
    // row stays flagged while its suggestion equals the stored name, which the
    // no-op suppression then blanks: permanently flagged and unfixable.
    if (w.length < 2) continue;
    if (seen.has(w)) return true;
    seen.add(w);
  }
  return false;
}

/** Drop repeated words, preserving initials. Lockstep with hasDuplicateWord. */
function dedupeWords(words: string[]): string[] {
  const seen = new Set<string>();
  return words.filter((w) => {
    if (w.length < 2) return true;
    const key = w.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fixName(fullName: string, email: string): string {
  let name = fullName.normalize("NFC").trim();

  // A name that is only question marks, or that is itself an email address, holds
  // no information — start from the email's local part instead. Deliberately NOT
  // an early return: the derived name has to run the same pipeline as a stored
  // one, or characters the scanner rejects survive into the suggestion.
  if (QUESTION_MARKS_REGEX.test(name) || EMAIL_REGEX.test(name)) {
    name = deriveNameFromEmail(email);
  }

  // Convert typographic apostrophes rather than deleting them ("O’Brien" →
  // "O'Brien", not "OBrien"). They stay flagged; the fix just isn't destructive.
  name = name.replace(/[\u2018\u2019\u02BC]/g, "'");

  // Remove numbers
  name = name.replace(/[0-9]/g, "");

  // Replace periods with spaces (word-separator normalisation, e.g. "Jane.doe" → "Jane doe")
  name = name.replace(/\./g, " ");

  // Remove remaining special characters (keep letters, marks, spaces, hyphens, apostrophes)
  name = name.replace(/[^\p{L}\p{M}\s\-']/gu, "");

  // Collapse multiple spaces and trim
  name = name.replace(/\s+/g, " ").trim();

  // Remove duplicate words (e.g. "Jane Jane Doe" → "Jane Doe")
  const words = name.split(/\s+/).filter(Boolean);
  const deduped = dedupeWords(words);
  const removedDuplicate = deduped.length < words.length;
  name = deduped.join(" ");

  // Re-case only a uniformly-cased name: title-casing unconditionally would turn
  // "McDonald" into "Mcdonald" on a row flagged merely for whitespace, and with no
  // casing issue type nothing could detect or undo that. Applied AFTER the dedupe,
  // because the dedupe keeps the first spelling of a repeated word — "JANE Jane"
  // is mixed-case as a whole but collapses to the all-caps "JANE".
  if (name === name.toUpperCase() || name === name.toLowerCase()) {
    name = titleCaseName(name);
  }

  // De-duplication can leave a single word ("Jane Jane" → "Jane"). Prefer a fuller
  // name from the email, under two guards:
  //  - only when the dedupe (or a total wipe) is what shortened it, else a
  //    legitimately single-word name gets a surname invented for it;
  //  - only when the email plausibly names the same person, i.e. it shares the
  //    surviving word. Without this a shared or mis-keyed mailbox silently
  //    rewrites someone's name to a different person's — and the result is
  //    clean, so nothing ever flags it.
  if (deduped.length < 2 && (removedDuplicate || deduped.length === 0)) {
    const fromEmail = dedupeWords(deriveNameFromEmail(email).split(/\s+/).filter(Boolean));
    const survivor = deduped[0]?.toLowerCase();
    const sharesSurvivor =
      survivor === undefined || fromEmail.some((w) => w.toLowerCase() === survivor);
    if (fromEmail.length >= 2 && sharesSurvivor) {
      name = fromEmail.join(" ");
    }
  }

  return name;
}

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const students = await prisma.student.findMany({
    select: { email: true, fullName: true },
    orderBy: { fullName: "asc" },
  });

  const results = [];
  for (const s of students) {
    const issues = detectIssues(s.fullName);
    if (issues.length > 0) {
      const suggestedName = fixName(s.fullName, s.email);
      results.push({
        email: s.email,
        fullName: s.fullName,
        issues,
        // Compared against the RAW name, not the trimmed one, so a fix that only
        // removes leading/trailing whitespace isn't wrongly suppressed. Blank
        // means "no automatic fix" — the client prompts for a manual edit.
        suggestedName: suggestedName === s.fullName ? "" : suggestedName,
      });
    }
  }

  return NextResponse.json(results);
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body: unknown = await request.json();

  type Update = { email: string; fullName: string };
  let updates: Update[] = [];
  const rawUpdates = (body as { updates?: unknown })?.updates;
  if (Array.isArray(rawUpdates)) {
    updates = rawUpdates
      .filter((u): u is { email: string; fullName: string } =>
        !!u
        && typeof u === "object"
        && typeof (u as { email?: unknown }).email === "string"
        && typeof (u as { fullName?: unknown }).fullName === "string"
      )
      .map((u) => ({ email: u.email, fullName: u.fullName }));
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: "No updates provided" }, { status: 400 });
  }

  const emails = updates.map((u) => u.email);
  const students = await prisma.student.findMany({
    where: { email: { in: emails } },
    select: { email: true, fullName: true },
  });
  const studentByEmail = new Map<string, { email: string; fullName: string }>(
    students.map((s: { email: string; fullName: string }) => [s.email, s])
  );

  // The suggested name is operator-editable, so this deliberately does NOT re-run
  // fixName — that would fight a deliberate override. It only applies the
  // normalisation the operator can't reasonably be expected to do by hand.
  const writes: { email: string; fullName: string }[] = [];
  let skippedCount = 0;
  for (const u of updates) {
    const s = studentByEmail.get(u.email);
    if (!s) {
      skippedCount++;
      continue;
    }

    const newName = u.fullName.normalize("NFC").replace(/\s+/g, " ").trim();
    if (newName.length === 0 || newName.length > MAX_NAME_LENGTH || newName === s.fullName) {
      skippedCount++;
      continue;
    }

    writes.push({ email: s.email, fullName: newName });
  }

  // One transaction: a mid-loop failure across a few hundred selected rows would
  // otherwise half-apply with nothing surfaced to the operator.
  if (writes.length > 0) {
    await prisma.$transaction(
      writes.map((w) =>
        prisma.student.update({ where: { email: w.email }, data: { fullName: w.fullName } })
      )
    );
    // fullName appears in cached report output; every other student-mutation route
    // already does this.
    invalidateReportCache();
  }

  return NextResponse.json({ success: true, fixedCount: writes.length, skippedCount });
}
