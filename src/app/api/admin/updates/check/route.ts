import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";

const GITHUB_REPO = "M3ntalBadg3r/Training-Tracker";

/** The branch each update channel tracks — the same map the installer uses. */
const CHANNEL_BRANCH: Record<string, string> = {
  dev: "dev",
  stable: "master",
};

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

    // The dev channel publishes no releases, so there is no version to compare.
    // It tracks the `dev` branch directly and reports how far behind it is.
    if (channel === "dev") {
      return await checkDevChannel(currentVersion, headers);
    }

    return await checkReleaseChannel(currentVersion, channel, headers);
  } catch {
    return NextResponse.json(
      { error: "Failed to check for updates" },
      { status: 500 }
    );
  }
}

/**
 * Dev ("edge") channel: compare the commit this build came from against the head
 * of the branch the installer pulls.
 *
 * Every merge into `dev` used to publish a GitHub pre-release purely so this
 * check had a version to compare — 64 releases in a week, on a page customers
 * read. The branch head is the same signal without the noise.
 */
async function checkDevChannel(
  currentVersion: string,
  headers: Record<string, string>
) {
  const branch = CHANNEL_BRANCH.dev;
  const currentCommit = process.env.APP_COMMIT || "";

  const base = {
    currentVersion,
    channel: "dev",
    branch,
    mode: "commits" as const,
    currentCommit,
  };

  // No commit means this build did not come from a git checkout. Report that
  // plainly rather than claiming the install is up to date.
  if (!currentCommit) {
    return NextResponse.json({
      ...base,
      latestVersion: null,
      updateAvailable: false,
      error:
        "Could not determine which commit this build came from, so it cannot be compared with the dev branch.",
    });
  }

  const compare = await fetchJson(
    `https://api.github.com/repos/${GITHUB_REPO}/compare/${currentCommit}...${branch}`,
    headers
  );

  if (compare && typeof compare.ahead_by === "number") {
    type CompareCommit = { sha?: string; commit?: { message?: string } };
    const commits: CompareCommit[] = Array.isArray(compare.commits)
      ? (compare.commits as CompareCommit[])
      : [];
    return NextResponse.json({
      ...base,
      latestVersion: null,
      latestCommit: commits[commits.length - 1]?.sha || null,
      commitsBehind: compare.ahead_by,
      updateAvailable: compare.ahead_by > 0,
      // Newest first, and only the subject line of each commit.
      changes: commits
        .map((c) => String(c.commit?.message || "").split("\n")[0].trim())
        .filter(Boolean)
        .reverse(),
    });
  }

  // The compare can 404 when the installed commit is no longer reachable (a
  // force-push, or a build from a commit that never reached the remote). Fall
  // back to a plain head-of-branch check: it cannot count the commits, but it
  // can still tell whether there is something new.
  const head = await fetchJson(
    `https://api.github.com/repos/${GITHUB_REPO}/commits/${branch}`,
    headers
  );

  if (head && typeof head.sha === "string") {
    const differs = head.sha !== currentCommit;
    return NextResponse.json({
      ...base,
      latestVersion: null,
      latestCommit: head.sha,
      commitsBehind: null,
      updateAvailable: differs,
      changes: [],
    });
  }

  return NextResponse.json({
    ...base,
    latestVersion: null,
    updateAvailable: false,
    error: "Could not reach GitHub to compare with the dev branch.",
  });
}

/** Stable (and any future release-backed) channel: compare release versions. */
async function checkReleaseChannel(
  currentVersion: string,
  channel: string,
  headers: Record<string, string>
) {
  // Always fetch the releases list and pick the highest version ourselves.
  // GitHub's /releases/latest relies on created_at ordering which breaks when
  // a pre-release is promoted to stable after a newer pre-release has been created.
  //
  // per_page is 100 rather than a smaller window because the list still holds
  // years of the old per-merge pre-releases: a short window could fill entirely
  // with pre-releases and leave a stable install seeing none of its own channel.
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100`;

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

  const candidates = data.filter((r) => !r.prerelease && !r.draft);
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
    branch: CHANNEL_BRANCH[channel] || "master",
    mode: "release" as const,
    latestVersion,
    updateAvailable,
    prerelease: !!release.prerelease,
    releaseName: release.name || "",
    releaseNotes: release.body || "",
    publishedAt: release.published_at || "",
    htmlUrl: release.html_url || "",
  });
}

/** GET a GitHub JSON endpoint, returning null on any failure. */
async function fetchJson(
  url: string,
  headers: Record<string, string>
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers, next: { revalidate: 0 } });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function parseVersionNumber(version: string): number {
  const clean = version.replace(/-dev$/, "");
  const parts = clean.split(".");
  const major = parseInt(parts[0] || "0", 10);
  const minor = parseInt(parts[1] || "0", 10);
  return major * 1000 + minor;
}
