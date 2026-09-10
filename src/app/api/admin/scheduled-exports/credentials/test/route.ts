import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { checkCredential } from "@/lib/credential-health";

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  const provider = String((body as { provider?: unknown } | null)?.provider ?? "");
  if (!provider) {
    return NextResponse.json({ success: false, error: "provider is required" }, { status: 400 });
  }

  try {
    const result = await checkCredential(provider);
    return NextResponse.json({
      success: result.status === "ok",
      status: result.status,
      info: result.info,
      error: result.error,
    });
  } catch (err) {
    // checkCredential classifies transport failures itself, so reaching here is
    // unexpected. Keep it off the wire and out of a 500.
    console.warn(`[credentials/test] ${provider} test threw:`, err);
    return NextResponse.json({
      success: false,
      status: "failed",
      error: "The connection test failed. See the server log for details.",
    });
  }
}
