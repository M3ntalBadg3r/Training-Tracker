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
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
    };
    const githubToken = process.env.GITHUB_TOKEN;
    if (githubToken) {
      headers["Authorization"] = `Bearer ${githubToken}`;
    }

    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=5`,
      { headers, next: { revalidate: 0 } }
    );

    if (!response.ok) {
      return NextResponse.json({ releases: [] });
    }

    const releases = await response.json();

    const mapped = releases.map(
      (r: {
        tag_name: string;
        name: string;
        body: string;
        published_at: string;
        html_url: string;
      }) => ({
        version: (r.tag_name || "").replace(/^v/, ""),
        name: r.name || "",
        notes: r.body || "",
        publishedAt: r.published_at || "",
        htmlUrl: r.html_url || "",
      })
    );

    return NextResponse.json({
      releases: mapped,
      releasesUrl: `https://github.com/${GITHUB_REPO}/releases`,
    });
  } catch {
    return NextResponse.json({ releases: [] });
  }
}
