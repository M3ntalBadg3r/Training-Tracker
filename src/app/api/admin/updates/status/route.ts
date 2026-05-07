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

    // Clean up status file only when explicitly requested via ?ack=1
    const ack = request.nextUrl.searchParams.get("ack");
    if (ack === "1" && (status.status === "complete" || status.status === "error")) {
      fs.unlinkSync(statusFile);
    }

    return NextResponse.json(status);
  } catch {
    return NextResponse.json({ status: "idle" });
  }
}
