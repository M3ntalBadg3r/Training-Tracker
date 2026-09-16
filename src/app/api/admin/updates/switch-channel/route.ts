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

const GITHUB_REPO = "M3ntalBadg3r/Training-Tracker";

/**
 * The three channels, each of which is simply a branch the installer pulls —
 * mirroring `branch_for_channel` in deploy/lib/common.sh.
 */
const CHANNEL_BRANCH = {
  dev: "dev",
  beta: "beta",
  stable: "master",
} as const;

type Channel = keyof typeof CHANNEL_BRANCH;

/**
 * Which request literal asks the root helper for each channel.
 *
 * The literals are an enum shared across a process boundary; the agent matches
 * whole strings against a closed set, so this table selects one rather than
 * building it. scripts/check-deploy-parity.mjs executes the agent's `case` to
 * prove every literal here dispatches to its own arm.
 */
const CHANNEL_REQUEST: Record<Channel, (typeof UPDATE_REQUESTS)[keyof typeof UPDATE_REQUESTS]> = {
  dev: UPDATE_REQUESTS.switchToDev,
  beta: UPDATE_REQUESTS.switchToBeta,
  stable: UPDATE_REQUESTS.switchToStable,
};

function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && Object.hasOwn(CHANNEL_BRANCH, value);
}

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const { channel } = await request.json();
    if (!isChannel(channel)) {
      return NextResponse.json(
        { error: "Invalid channel. Must be 'dev', 'beta' or 'stable'." },
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
    const targetBranch = CHANNEL_BRANCH[channel];

    // Refuse a switch that would move this install BACKWARDS.
    //
    // This used to compare version numbers against /releases/latest, which only
    // worked for dev -> stable and, with three channels, would strand a box on
    // edge for ever. It also measured the wrong thing. The hazard is not the
    // version number: `git checkout` moves the code backwards while **Prisma
    // migrations do not roll back**, so a box that ran a dev migration and then
    // switched to stable has a database ahead of its schema.
    //
    // Asking whether the target branch CONTAINS the commit we are running
    // measures that directly. "ahead" or "identical" means the target already
    // has our code and the switch is safe; "behind" or "diverged" means it does
    // not. It reduces to the old behaviour for dev -> stable and generalises to
    // every other pair for free.
    const currentCommit = process.env.APP_COMMIT || "";
    if (currentCommit) {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github.v3+json",
      };
      const githubToken = process.env.GITHUB_TOKEN;
      if (githubToken) {
        headers["Authorization"] = `Bearer ${githubToken}`;
      }

      let status: string | null = null;
      try {
        const response = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/compare/${currentCommit}...${targetBranch}`,
          { headers, next: { revalidate: 0 } }
        );
        if (response.ok) {
          const body = await response.json();
          status = typeof body?.status === "string" ? body.status : null;
        }
      } catch {
        /* handled below: an unanswered question does not block the switch */
      }

      if (status === "behind" || status === "diverged") {
        return NextResponse.json(
          {
            error: "blocked",
            message:
              `Cannot switch to ${channel} — the ${targetBranch} branch does not yet ` +
              `include the code this system is running (v${currentVersion}). Moving ` +
              `to it would roll the application back, and database migrations that ` +
              `have already run are not reversed.`,
            currentVersion,
            targetBranch,
          },
          { status: 409 }
        );
      }
      // A null status means GitHub could not be reached, or the installed commit
      // is no longer on the remote. Neither is evidence of a downgrade, and
      // refusing on "I could not check" would strand a box whose network is
      // merely flaky. The update itself still validates and can roll back.
    }

    const appDir = process.cwd();

    if (!updateHelperInstalled(appDir)) {
      return NextResponse.json(
        { error: UPDATE_HELPER_MISSING },
        { status: 503 }
      );
    }

    // Update UPDATE_CHANNEL in .env (the service user owns .env)
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

    // Ask the root-owned helper to switch branch and update. The target branch
    // is derived on the root side from the request literal, never sent as an
    // argument — see src/lib/update-request.ts.
    writeUpdateRequest(appDir, CHANNEL_REQUEST[channel]);

    return NextResponse.json({ status: "started", channel, targetBranch });
  } catch {
    return NextResponse.json(
      { error: "Failed to switch channel" },
      { status: 500 }
    );
  }
}
