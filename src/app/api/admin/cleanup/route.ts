import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBERS_REGEX = /[0-9]/;
// Allow letters (any script), spaces, hyphens, apostrophes, and periods
const SPECIAL_CHARS_REGEX = /[^\p{L}\s\-'.]/u;

function detectIssues(fullName: string): string[] {
  const issues: string[] = [];
  if (fullName !== fullName.trim()) issues.push("leading_trailing_spaces");
  if (EMAIL_REGEX.test(fullName.trim())) issues.push("email_as_name");
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
  if (parts.length >= 2) {
    return titleCase(parts.join(" "));
  }
  return email;
}

function fixName(fullName: string, email: string): string {
  let name = fullName.trim();

  // If it's an email address used as a name, derive from email
  if (EMAIL_REGEX.test(name)) {
    name = deriveNameFromEmail(email);
  }

  // Remove numbers
  name = name.replace(/[0-9]/g, "");

  // Remove special characters (keep letters, spaces, hyphens, apostrophes, periods)
  name = name.replace(/[^\p{L}\s\-'.]/gu, "");

  // Collapse multiple spaces and trim
  name = name.replace(/\s+/g, " ").trim();

  // Title-case the result
  name = titleCase(name);

  return name;
}

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
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
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { emails } = await request.json();
  if (!Array.isArray(emails) || emails.length === 0) {
    return NextResponse.json({ error: "No emails provided" }, { status: 400 });
  }

  const students = await prisma.student.findMany({
    where: { email: { in: emails } },
    select: { email: true, fullName: true },
  });

  let fixedCount = 0;
  for (const s of students) {
    const newName = fixName(s.fullName, s.email);
    if (newName !== s.fullName) {
      await prisma.student.update({
        where: { email: s.email },
        data: { fullName: newName },
      });
      fixedCount++;
    }
  }

  return NextResponse.json({ success: true, fixedCount });
}
