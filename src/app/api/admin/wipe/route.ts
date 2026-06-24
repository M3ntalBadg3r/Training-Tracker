import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import {
  requireSuperAdmin,
  handleAuthError,
  clearAuthCookie,
  isRequestSecure,
} from "@/lib/auth";

type WipeScope = "data" | "all";

/**
 * Wipe all operational data. Two scopes:
 *  - "data" (default): wipe everything except user accounts and the system
 *    settings singleton — companies and their access links are removed too,
 *    leaving only login accounts. Admins stay signed in.
 *  - "all": factory reset — also removes companies, system settings and every
 *    user, returning the instance to the first-run setup wizard. The caller's
 *    auth cookie is cleared so they're redirected to /setup.
 */
export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  let scope: WipeScope = "data";
  try {
    const body = await request.json();
    if (body?.scope === "all") scope = "all";
  } catch {
    // No body / invalid JSON — default to "data".
  }

  await prisma.$transaction(async (tx: PrismaTransactionClient) => {
    // Children first to respect FK constraints (training_data -> product_types
    // is ON DELETE RESTRICT, so product types must be cleared after training).
    await tx.trainingTaken.deleteMany({});
    await tx.olxSubItemRelation.deleteMany({});
    await tx.programDataAlternative.deleteMany({});
    await tx.programData.deleteMany({});
    await tx.specialisation.deleteMany({});
    await tx.student.deleteMany({});
    await tx.scheduledExport.deleteMany({});
    await tx.trainingData.deleteMany({});
    await tx.productType.deleteMany({});
    await tx.regionData.deleteMany({});
    await tx.exportCredential.deleteMany({});
    await tx.importMetadata.deleteMany({});
    await tx.importAlias.deleteMany({});

    // Both scopes remove companies and their access links (keep only accounts).
    await tx.userCompany.deleteMany({});
    await tx.company.deleteMany({});

    if (scope === "all") {
      // Factory reset: drop system settings and every user account.
      await tx.systemSetting.deleteMany({});
      await tx.user.deleteMany({});
    }
  });

  const message =
    scope === "all"
      ? "All data, settings and user accounts have been wiped. The system has been reset to its initial state."
      : "All data has been wiped. User accounts have been preserved.";

  const response = NextResponse.json({ success: true, scope, message });
  if (scope === "all") {
    // The current session's user no longer exists — clear the cookie so the
    // client lands on the first-run setup wizard.
    clearAuthCookie(response, isRequestSecure(request));
  }
  return response;
}
