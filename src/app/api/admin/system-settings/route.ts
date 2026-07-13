import { NextRequest, NextResponse } from "next/server";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import {
  getSystemDateFormat,
  setSystemDateFormat,
  getSessionIdleMinutes,
  setSessionIdleMinutes,
  MIN_SESSION_IDLE_MINUTES,
  MAX_SESSION_IDLE_MINUTES,
} from "@/lib/system-settings";
import { isDateFormat } from "@/lib/date-format";

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  const [dateFormat, sessionIdleMinutes] = await Promise.all([
    getSystemDateFormat(),
    getSessionIdleMinutes(),
  ]);
  return NextResponse.json({ dateFormat, sessionIdleMinutes });
}

export async function PUT(request: NextRequest) {
  let auth;
  try {
    auth = await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Partial update: a request may set the date format, the idle timeout, or both.
  const hasDateFormat = body.dateFormat !== undefined;
  const hasIdle = body.sessionIdleMinutes !== undefined;
  if (!hasDateFormat && !hasIdle) {
    return NextResponse.json({ error: "No settings provided" }, { status: 400 });
  }

  if (hasDateFormat) {
    if (!isDateFormat(body.dateFormat)) {
      return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
    }
    await setSystemDateFormat(body.dateFormat, auth.sub);
  }

  if (hasIdle) {
    const minutes = Number(body.sessionIdleMinutes);
    if (
      !Number.isFinite(minutes) ||
      minutes < MIN_SESSION_IDLE_MINUTES ||
      minutes > MAX_SESSION_IDLE_MINUTES
    ) {
      return NextResponse.json(
        {
          error: `Idle timeout must be between ${MIN_SESSION_IDLE_MINUTES} and ${MAX_SESSION_IDLE_MINUTES} minutes`,
        },
        { status: 400 }
      );
    }
    await setSessionIdleMinutes(minutes, auth.sub);
  }

  const [dateFormat, sessionIdleMinutes] = await Promise.all([
    getSystemDateFormat(),
    getSessionIdleMinutes(),
  ]);
  return NextResponse.json({ dateFormat, sessionIdleMinutes });
}
