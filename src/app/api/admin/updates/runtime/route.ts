import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { assessRunningNode } from "@/lib/node-runtime";

/**
 * The Node.js runtime this server is running on, judged against the security
 * floor in `deploy/lib/node-runtime.mjs`. Feeds the runtime line on Admin ›
 * Updates.
 *
 * SuperAdmin-only (`/api/admin/updates` is in the proxy's SuperAdmin prefixes
 * and guarded here as well): an exact runtime version is a fingerprinting
 * primitive, which is the same reason the app version is not exposed before
 * sign-in. It reads `process.versions.node` (via `assessRunningNode`), i.e.
 * the binary actually serving requests — after an upgrade the package on disk
 * is newer until the service restarts, and the running one is what matters.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const assessment = assessRunningNode();
  return NextResponse.json({
    node: {
      version: assessment.version,
      status: assessment.status,
      floor: assessment.floor,
    },
  });
}
