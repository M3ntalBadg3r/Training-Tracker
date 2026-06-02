import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBERS_REGEX = /[0-9]/;
// Allow letters (any script), spaces, hyphens, and apostrophes — periods are flagged; digits excluded (covered by NUMBERS_REGEX)
const SPECIAL_CHARS_REGEX = /[^\p{L}\s\-'\d]/u;
// Matches a name composed solely of question marks and whitespace, with at least one '?'
const QUESTION_MARKS_REGEX = /^[\s?]*\?[\s?]*$/;

function detectIssues(fullName: string): string[] {
  const issues: string[] = [];
  if (fullName !== fullName.trim()) issues.push("leading_trailing_spaces");
  if (EMAIL_REGEX.test(fullName.trim())) issues.push("email_as_name");
  if (QUESTION_MARKS_REGEX.test(fullName.trim())) issues.push("question_marks");
  if (hasDuplicateWord(fullName)) issues.push("duplicate_name");
  if (NUMBERS_REGEX.test(fullName)) issues.push("numbers");
  if (SPECIAL_CHARS_REGEX.test(fullName) && !EMAIL_REGEX.test(fullName.trim())) {
    issues.push("special_characters");
  }
  return issues;
}

function titleCase(str: string): string {
  return str
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function deriveNameFromEmail(email: string): string {
  const local = email.split("@")[0];
  const parts = local.split(/[._-]/);
  return titleCase(parts.join(" "));
}

function hasDuplicateWord(fullName: string): boolean {
  // Normalize the way fixName does so duplicates emerging after cleanup are also detected
  // (e.g. "Artem Artem.zaytsev" — the dot is later replaced with a space, exposing the duplicate)
  const normalized = fullName
    .trim()
    .toLowerCase()
    .replace(/[0-9]/g, "")
    .replace(/\./g, " ")
    .replace(/[^\p{L}\s\-']/gu, "");
  const words = normalized.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  for (const w of words) {
    if (seen.has(w)) return true;
    seen.add(w);
  }
  return false;
}

function fixName(fullName: string, email: string): string {
  let name = fullName.trim();

  // Name is only question marks — derive from email
  if (QUESTION_MARKS_REGEX.test(name)) {
    return deriveNameFromEmail(email);
  }

  // If it's an email address used as a name, derive from email
  if (EMAIL_REGEX.test(name)) {
    name = deriveNameFromEmail(email);
  }

  // Remove numbers
  name = name.replace(/[0-9]/g, "");

  // Replace periods with spaces (word-separator normalisation, e.g. "Allam.srilakshmi" → "Allam srilakshmi")
  name = name.replace(/\./g, " ");

  // Remove remaining special characters (keep letters, spaces, hyphens, apostrophes)
  name = name.replace(/[^\p{L}\s\-']/gu, "");

  // Collapse multiple spaces and trim
  name = name.replace(/\s+/g, " ").trim();

  // Title-case the result
  name = titleCase(name);

  // Remove duplicate words (e.g. "Artem Artem Zaytsev" → "Artem Zaytsev")
  const words = name.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const deduped = words.filter((w) => {
    const key = w.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  name = deduped.join(" ");

  // If de-duplication left only a single word (e.g. "Jane Jane" → "Jane"),
  // try to recover a fuller name from the email's local part.
  if (deduped.length < 2) {
    const fromEmail = deriveNameFromEmail(email);
    if (fromEmail.split(/\s+/).filter(Boolean).length >= 2) {
      name = fromEmail;
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
      results.push({
        email: s.email,
        fullName: s.fullName,
        issues,
        suggestedName: fixName(s.fullName, s.email),
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

  let fixedCount = 0;
  for (const u of updates) {
    const s = studentByEmail.get(u.email);
    if (!s) continue;

    const newName = u.fullName.trim();
    if (newName.length === 0) continue;
    if (newName === s.fullName) continue;

    await prisma.student.update({
      where: { email: s.email },
      data: { fullName: newName },
    });
    fixedCount++;
  }

  return NextResponse.json({ success: true, fixedCount });
}
