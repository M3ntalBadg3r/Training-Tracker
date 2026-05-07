import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

const GITHUB_REPO = "M3ntalBadg3r/Training-Tracker";

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  try {
    const currentVersion = process.env.APP_VERSION || "0.0";
    const channel = process.env.UPDATE_CHANNEL || "stable";

    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
    };
    const githubToken = process.env.GITHUB_TOKEN;
    if (githubToken) {
      headers["Authorization"] = `Bearer ${githubToken}`;
    }

    // Always fetch the releases list and pick the highest version ourselves.
    // GitHub's /releases/latest relies on created_at ordering which breaks when
    // a pre-release is promoted to stable after a newer pre-release has been created.
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=20`;

    const response = await fetch(url, { headers, next: { revalidate: 0 } });

    if (!response.ok) {
      if (response.status === 404) {
        return NextResponse.json({
          currentVersion,
          channel,
          latestVersion: null,
          updateAvailable: false,
          message: "No releases found",
        });
      }
      return NextResponse.json({
        currentVersion,
        channel,
        latestVersion: null,
        updateAvailable: false,
        error: `GitHub API returned ${response.status}`,
      });
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      return NextResponse.json({
        currentVersion,
        channel,
        latestVersion: null,
        updateAvailable: false,
        error: "Unexpected response from GitHub API",
      });
    }

    // Stable: only consider non-prerelease releases; Dev: consider all releases
    const candidates = channel === "dev" ? data : data.filter((r) => !r.prerelease && !r.draft);
    const release = candidates.reduce(
      (best: typeof data[0] | null, r: typeof data[0]) => {
        if (!best) return r;
        const v = parseVersionNumber((r.tag_name || "").replace(/^v/, ""));
        const bestV = parseVersionNumber((best.tag_name || "").replace(/^v/, ""));
        return v > bestV ? r : best;
      },
      null
    );

    if (!release) {
      return NextResponse.json({
        currentVersion,
        channel,
        latestVersion: null,
        updateAvailable: false,
        message: "No releases found",
      });
    }

    const latestVersion = (release.tag_name || "").replace(/^v/, "");

    const currentNum = parseVersionNumber(currentVersion);
    const latestNum = parseVersionNumber(latestVersion);
    const updateAvailable = latestNum > currentNum;

    return NextResponse.json({
      currentVersion,
      channel,
      latestVersion,
      updateAvailable,
      prerelease: !!release.prerelease,
      releaseName: release.name || "",
      releaseNotes: release.body || "",
      publishedAt: release.published_at || "",
      htmlUrl: release.html_url || "",
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to check for updates" },
      { status: 500 }
    );
  }
}

function parseVersionNumber(version: string): number {
  const clean = version.replace(/-dev$/, "");
  const parts = clean.split(".");
  const major = parseInt(parts[0] || "0", 10);
  const minor = parseInt(parts[1] || "0", 10);
  return major * 1000 + minor;
}
