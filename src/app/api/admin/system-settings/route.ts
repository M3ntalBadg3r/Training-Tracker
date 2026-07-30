import { NextRequest, NextResponse } from "next/server";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import {
  getSystemDateFormat,
  setSystemDateFormat,
  getSessionIdleMinutes,
  setSessionIdleMinutes,
  getPublicApiEnabled,
  setPublicApiEnabled,
  MIN_SESSION_IDLE_MINUTES,
  MAX_SESSION_IDLE_MINUTES,
} from "@/lib/system-settings";
import { isDateFormat } from "@/lib/date-format";

/** Current values of every system-wide setting. */
async function readAll() {
  const [dateFormat, sessionIdleMinutes, publicApiEnabled] = await Promise.all([
    getSystemDateFormat(),
    getSessionIdleMinutes(),
    getPublicApiEnabled(),
  ]);
  return { dateFormat, sessionIdleMinutes, publicApiEnabled };
}

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  return NextResponse.json(await readAll());
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

  // Partial update: a request may set any combination of the settings below.
  const hasDateFormat = body.dateFormat !== undefined;
  const hasIdle = body.sessionIdleMinutes !== undefined;
  const hasPublicApi = body.publicApiEnabled !== undefined;
  if (!hasDateFormat && !hasIdle && !hasPublicApi) {
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

  if (hasPublicApi) {
    if (typeof body.publicApiEnabled !== "boolean") {
      return NextResponse.json(
        { error: "publicApiEnabled must be true or false" },
        { status: 400 }
      );
    }
    await setPublicApiEnabled(body.publicApiEnabled, auth.sub);
  }

  return NextResponse.json(await readAll());
}
