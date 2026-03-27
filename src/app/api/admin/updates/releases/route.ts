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
    const channel = process.env.UPDATE_CHANNEL || "stable";

    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
    };
    const githubToken = process.env.GITHUB_TOKEN;
    if (githubToken) {
      headers["Authorization"] = `Bearer ${githubToken}`;
    }

    // Fetch more releases so we have enough after filtering for stable channel
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=15`,
      { headers, next: { revalidate: 0 } }
    );

    if (!response.ok) {
      return NextResponse.json({ releases: [], channel });
    }

    const releases: {
      tag_name: string;
      name: string;
      body: string;
      published_at: string;
      html_url: string;
      prerelease: boolean;
    }[] = await response.json();

    // Stable channel: filter out pre-releases; Dev channel: show all
    const filtered =
      channel === "stable"
        ? releases.filter((r) => !r.prerelease)
        : releases;

    const mapped = filtered.slice(0, 5).map((r) => ({
      version: (r.tag_name || "").replace(/^v/, ""),
      name: r.name || "",
      notes: r.body || "",
      publishedAt: r.published_at || "",
      htmlUrl: r.html_url || "",
      prerelease: !!r.prerelease,
    }));

    return NextResponse.json({
      releases: mapped,
      channel,
      releasesUrl: `https://github.com/${GITHUB_REPO}/releases`,
    });
  } catch {
    return NextResponse.json({ releases: [], channel: "stable" });
  }
}
