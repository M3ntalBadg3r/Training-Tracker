import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError, AuthError } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { verifyCronSignature } from "@/lib/cron-auth";
import { checkCredential, getCredentialHealthSummary } from "@/lib/credential-health";

interface CheckBody {
  provider?: string;
}

/**
 * Run health checks against the configured credentials.
 *
 * Auth: either an admin session OR a valid HMAC `X-Cron-Signature` header.
 * Body: optional `{provider}` to check just one provider; omitted = all configured.
 */
export async function POST(request: NextRequest) {
  const cronSignature = request.headers.get("x-cron-signature");
  const cronAuthorised = verifyCronSignature(cronSignature);

  if (!cronAuthorised) {
    try {
      await requireAuth(request, "Admin");
    } catch (error) {
      return handleAuthError(error as AuthError);
    }
  }

  let body: CheckBody = {};
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      body = (await request.json()) as CheckBody;
    }
  } catch {
    body = {};
  }

  const providers = body.provider
    ? [body.provider]
    : (await prisma.exportCredential.findMany({ select: { provider: true } })).map(
        (r: { provider: string }) => r.provider,
      );

  const results: Array<{ provider: string; status: string; error?: string }> = [];
  for (const provider of providers) {
    try {
      const result = await checkCredential(provider);
      results.push({ provider, status: result.status, error: result.error });
    } catch (err) {
      // The probe already classifies its own transport failures; anything
      // reaching here is unexpected, so log it and stay generic.
      console.warn(`[credentials/check] ${provider} check threw:`, err);
      results.push({
        provider,
        status: "failed",
        error: "The connection test failed. See the server log for details.",
      });
    }
  }

  const summary = await getCredentialHealthSummary();
  return NextResponse.json({ checked: results.length, results, summary });
}
