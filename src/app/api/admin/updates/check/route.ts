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
      if (response.status === 404) {
        return NextResponse.json({
          currentVersion,
          latestVersion: null,
          updateAvailable: false,
          message: "No releases found",
        });
      }
      return NextResponse.json({
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        error: `GitHub API returned ${response.status}`,
      });
    }

    const release = await response.json();
    const latestVersion = (release.tag_name || "").replace(/^v/, "");

    const currentNum = parseVersionNumber(currentVersion);
    const latestNum = parseVersionNumber(latestVersion);
    const updateAvailable = latestNum > currentNum;

    return NextResponse.json({
      currentVersion,
      latestVersion,
      updateAvailable,
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
  const parts = version.split(".");
  const major = parseInt(parts[0] || "0", 10);
  const minor = parseInt(parts[1] || "0", 10);
  return major * 1000 + minor;
}
