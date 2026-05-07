import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const GITHUB_REPO = "M3ntalBadg3r/Training-Tracker";

function parseVersionNumber(version: string): number {
  const parts = version.split(".");
  const major = parseInt(parts[0] || "0", 10);
  const minor = parseInt(parts[1] || "0", 10);
  return major * 1000 + minor;
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const { channel } = await request.json();
    if (channel !== "dev" && channel !== "stable") {
      return NextResponse.json(
        { error: "Invalid channel. Must be 'dev' or 'stable'." },
        { status: 400 }
      );
    }

    const currentChannel = process.env.UPDATE_CHANNEL || "stable";
    if (channel === currentChannel) {
      return NextResponse.json(
        { error: `Already on the ${channel} channel.` },
        { status: 400 }
      );
    }

    const currentVersion = process.env.APP_VERSION || "0.0";
    const currentNum = parseVersionNumber(currentVersion);

    // If switching dev → stable, verify stable has caught up
    if (channel === "stable") {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github.v3+json",
      };
      const githubToken = process.env.GITHUB_TOKEN;
      if (githubToken) {
        headers["Authorization"] = `Bearer ${githubToken}`;
      }

      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        { headers, next: { revalidate: 0 } }
      );

      if (!response.ok) {
        return NextResponse.json(
          { error: "Could not check latest stable release from GitHub." },
          { status: 500 }
        );
      }

      const release = await response.json();
      const latestStable = (release.tag_name || "").replace(/^v/, "");
      const latestStableNum = parseVersionNumber(latestStable);

      if (currentNum > latestStableNum) {
        return NextResponse.json(
          {
            error: "blocked",
            message: `Cannot switch to stable — your installed version (v${currentVersion}) is ahead of the latest stable release (v${latestStable}). The stable channel must reach v${currentVersion} or higher first.`,
            currentVersion,
            latestStableVersion: latestStable,
          },
          { status: 409 }
        );
      }
    }

    // Update UPDATE_CHANNEL in .env
    const appDir = process.cwd();
    const envPath = path.join(appDir, ".env");
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, "utf-8");
      if (envContent.match(/^UPDATE_CHANNEL=/m)) {
        envContent = envContent.replace(
          /^UPDATE_CHANNEL=.*/m,
          `UPDATE_CHANNEL="${channel}"`
        );
      } else {
        envContent += `\nUPDATE_CHANNEL="${channel}"\n`;
      }
      fs.writeFileSync(envPath, envContent);
    }

    // Write initial status
    const statusFile = path.join(appDir, ".update-status");
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        step: 0,
        totalSteps: 8,
        message: `Switching to ${channel} channel...`,
        status: "in_progress",
      })
    );

    // Spawn perform-update.sh with TARGET_BRANCH env var
    // Use systemd-run --scope so the script survives the service
    // restart at step 6 (systemctl restart kills the entire cgroup)
    const scriptPath = path.join(appDir, "deploy", "perform-update.sh");
    const targetBranch = channel === "dev" ? "dev" : "master";
    const child = spawn(
      "systemd-run",
      ["--scope", "--unit=tt-channel-switch", "bash", scriptPath, appDir],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          PATH: process.env.PATH,
          TARGET_BRANCH: targetBranch,
        },
      }
    );
    child.unref();

    return NextResponse.json({ status: "started", channel, targetBranch });
  } catch {
    return NextResponse.json(
      { error: "Failed to switch channel" },
      { status: 500 }
    );
  }
}
