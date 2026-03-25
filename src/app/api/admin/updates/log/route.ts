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
    const logFile = path.join(process.cwd(), ".update-log");

    if (!fs.existsSync(logFile)) {
      return NextResponse.json({ log: null, message: "No update log found" });
    }

    const content = fs.readFileSync(logFile, "utf-8");
    return NextResponse.json({ log: content });
  } catch {
    return NextResponse.json(
      { error: "Failed to read update log" },
      { status: 500 }
    );
  }
}
