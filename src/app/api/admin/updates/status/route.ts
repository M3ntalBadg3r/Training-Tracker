import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";
import path from "path";
import fs from "fs";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const statusFile = path.join(process.cwd(), ".update-status");

    if (!fs.existsSync(statusFile)) {
      return NextResponse.json({ status: "idle" });
    }

    const content = fs.readFileSync(statusFile, "utf-8");
    const status = JSON.parse(content);

    // Clean up status file if update is complete or errored
    if (status.status === "complete" || status.status === "error") {
      // Keep the file for one more read, then mark for cleanup
      if (!status._read) {
        fs.writeFileSync(
          statusFile,
          JSON.stringify({ ...status, _read: true })
        );
      } else {
        fs.unlinkSync(statusFile);
      }
    }

    return NextResponse.json(status);
  } catch {
    return NextResponse.json({ status: "idle" });
  }
}
