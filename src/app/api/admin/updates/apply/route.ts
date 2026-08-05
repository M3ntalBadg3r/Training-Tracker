import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import path from "path";
import fs from "fs";
import {
  UPDATE_REQUESTS,
  writeUpdateRequest,
  updateHelperInstalled,
  UPDATE_HELPER_MISSING,
} from "@/lib/update-request";

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const appDir = process.cwd();

    if (!updateHelperInstalled(appDir)) {
      return NextResponse.json(
        { error: UPDATE_HELPER_MISSING },
        { status: 503 }
      );
    }

    // Write initial status
    const statusFile = path.join(appDir, ".update-status");
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        step: 0,
        totalSteps: 8,
        message: "Starting update...",
        status: "in_progress",
      })
    );

    // Ask the root-owned helper to do the privileged part. The app holds no
    // privilege of its own — see src/lib/update-request.ts. This also means the
    // updater runs in its own unit, so the service restart it performs at step 6
    // cannot kill it mid-update.
    writeUpdateRequest(appDir, UPDATE_REQUESTS.update);

    return NextResponse.json({ status: "started" });
  } catch (error) {
    console.error("Failed to start update:", error);
    return NextResponse.json(
      {
        error:
          "Failed to start update. Check the server log: " +
          "journalctl -u training-tracker",
      },
      { status: 500 }
    );
  }
}
