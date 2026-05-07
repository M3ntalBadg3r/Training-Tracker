import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const appDir = process.cwd();
    const scriptPath = path.join(appDir, "deploy", "perform-update.sh");

    if (!fs.existsSync(scriptPath)) {
      return NextResponse.json(
        { error: "Update script not found" },
        { status: 500 }
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

    // Spawn in a separate systemd scope so the script survives
    // the service restart at step 6 (systemctl restart kills the
    // entire service cgroup, which would kill a plain child process)
    const child = spawn(
      "systemd-run",
      ["--scope", "--unit=tt-update", "bash", scriptPath, appDir],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, PATH: process.env.PATH },
      }
    );
    child.unref();

    return NextResponse.json({ status: "started" });
  } catch {
    return NextResponse.json(
      { error: "Failed to start update" },
      { status: 500 }
    );
  }
}
