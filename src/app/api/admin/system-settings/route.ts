import { NextRequest, NextResponse } from "next/server";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { getSystemDateFormat, setSystemDateFormat } from "@/lib/system-settings";
import { isDateFormat } from "@/lib/date-format";

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  const dateFormat = await getSystemDateFormat();
  return NextResponse.json({ dateFormat });
}

export async function PUT(request: NextRequest) {
  let auth;
  try {
    auth = await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json().catch(() => null);
  const dateFormat = body?.dateFormat;
  if (!isDateFormat(dateFormat)) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  await setSystemDateFormat(dateFormat, auth.sub);
  return NextResponse.json({ dateFormat });
}
