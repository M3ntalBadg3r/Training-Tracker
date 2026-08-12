import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import path from "path";
import fs from "fs";

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
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

    // Clear the status only when explicitly requested via ?ack=1.
    //
    // Truncate to an idle payload rather than unlinking: the file is root-owned
    // (the update helper writes it as root — see ensure_state_file in
    // deploy/lib/common.sh) and APP_DIR carries the sticky bit, so this process
    // can write the file through its group but cannot delete it. A missing file
    // and an idle payload are treated identically above, so nothing else changes.
    const ack = request.nextUrl.searchParams.get("ack");
    if (ack === "1" && (status.status === "complete" || status.status === "error")) {
      fs.writeFileSync(statusFile, JSON.stringify({ status: "idle" }));
    }

    return NextResponse.json(status);
  } catch (error) {
    // Reporting "idle" for a real failure is how a broken update looks like a
    // stalled one. Leave a trace in journalctl -u training-tracker.
    console.error("Failed to read update status:", error);
    return NextResponse.json({ status: "idle" });
  }
}
