import { NextRequest, NextResponse } from "next/server";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { unblockUsername, unblockIp } from "@/lib/failed-attempts";

// POST: lift a block. Body: { scope: "username" | "ip", value }.
// - username → clears that account's lockout (failedLoginAttempts + lockedUntil).
// - ip       → clears every per-IP rate-limit bucket for that address.
export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json().catch(() => ({}));
  const { scope, value } = body as { scope?: string; value?: string };

  if (!value || typeof value !== "string" || !value.trim()) {
    return NextResponse.json({ error: "A value is required" }, { status: 400 });
  }

  if (scope === "username") {
    await unblockUsername(value.trim());
  } else if (scope === "ip") {
    await unblockIp(value.trim());
  } else {
    return NextResponse.json(
      { error: "scope must be 'username' or 'ip'" },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true });
}
