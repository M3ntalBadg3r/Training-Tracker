import { NextRequest, NextResponse } from "next/server";
import { requireAuth, handleAuthError } from "@/lib/auth";

const GITHUB_REPO = "M3ntalBadg3r/Training-Tracker";

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request, "Admin");
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

    // Dev channel: fetch recent releases and find the highest version
    // Stable channel: fetch /releases/latest (excludes pre-releases)
    const url =
      channel === "dev"
        ? `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`
        : `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

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
    // For dev channel, find the release with the highest version number
    // rather than relying on API ordering
    let release;
    if (channel === "dev" && Array.isArray(data)) {
      release = data.reduce(
        (best: typeof data[0] | null, r: typeof data[0]) => {
          if (!best) return r;
          const v = parseVersionNumber((r.tag_name || "").replace(/^v/, ""));
          const bestV = parseVersionNumber((best.tag_name || "").replace(/^v/, ""));
          return v > bestV ? r : best;
        },
        null
      );
    } else {
      release = channel === "dev" ? data[0] : data;
    }

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
