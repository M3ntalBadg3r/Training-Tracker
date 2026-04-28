import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getCredentialHealthSummary } from "@/lib/credential-health";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const summary = await getCredentialHealthSummary();
  return NextResponse.json(summary);
}
