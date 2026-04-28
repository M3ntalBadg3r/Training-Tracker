import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { checkCredential } from "@/lib/credential-health";

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const body = await request.json();
  const provider = String(body?.provider ?? "");
  if (!provider) {
    return NextResponse.json({ success: false, error: "provider is required" }, { status: 400 });
  }

  const result = await checkCredential(provider);
  return NextResponse.json({
    success: result.status === "ok",
    status: result.status,
    info: result.info,
    error: result.error,
  });
}
