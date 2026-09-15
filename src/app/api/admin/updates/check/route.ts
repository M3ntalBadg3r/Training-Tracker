import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { compareVersions, isNewerVersion, versionFromTag } from "@/lib/version";

const GITHUB_REPO = "M3ntalBadg3r/Training-Tracker";

/**
 * The branch each update channel tracks — the same map the installer uses
 * (`branch_for_channel` in deploy/lib/common.sh).
 *
 * A channel IS a branch: `dev` follows every merge, `beta` moves only when
 * someone deliberately fast-forwards it, `stable` moves on a release.
 */
const CHANNEL_BRANCH: Record<string, string> = {
  dev: "dev",
  beta: "beta",
  stable: "master",
};

/**
 * Channels that publish no releases and so have no version to compare. They
 * compare the commit this build came from against the head of their branch.
 */
const BRANCH_TRACKING_CHANNELS = new Set(["dev", "beta"]);

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

    // dev and beta publish no releases, so there is no version to compare. They
    // track a branch directly and report how far behind it is.
    if (BRANCH_TRACKING_CHANNELS.has(channel)) {
      return await checkBranchChannel(currentVersion, channel, headers);
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
 * A branch-tracking channel: compare the commit this build came from against the
 * head of the branch the installer pulls.
 *
 * Every merge into `dev` used to publish a GitHub pre-release purely so this
 * check had a version to compare — 64 releases in a week, on a page customers
 * read. The branch head is the same signal without the noise.
 *
 * `beta` uses this identically; only the branch differs. That is deliberate —
 * a second mechanism for "is there a new test build" would be a second thing to
 * keep in step with this one.
 *
 * Note a beta box's VERSION stays put between promotions, because nothing bumps
 * it in between. The commit count is the live signal; the version is the last
 * released label.
 */
async function checkBranchChannel(
  currentVersion: string,
  channel: string,
  headers: Record<string, string>
) {
  const branch = CHANNEL_BRANCH[channel] || "dev";
  const currentCommit = process.env.APP_COMMIT || "";

  const base = {
    currentVersion,
    channel,
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
        `Could not determine which commit this build came from, so it cannot be compared with the ${branch} branch.`,
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
    error: `Could not reach GitHub to compare with the ${branch} branch.`,
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
      const cmp = compareVersions(
        versionFromTag(r.tag_name),
        versionFromTag(best.tag_name)
      );
      return cmp > 0 ? r : best;
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

  const latestVersion = versionFromTag(release.tag_name);
  const updateAvailable = isNewerVersion(latestVersion, currentVersion);

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
