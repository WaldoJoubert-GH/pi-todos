import * as fs from "node:fs";
import * as cp from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GitHubRun,
  GitHubJob,
  GitHubLatestCache,
  GitHubActionsCache,
  GitHubJobsDetail,
  GitHubWidgetStatus,
  DevConfig,
} from "./types.js";
import {
  loadDevConfig,
  saveDevConfig,
  readLatestCache,
  writeLatestCache,
  readActionsCache,
  writeActionsCache,
  readJobsDetail,
  writeJobsDetail,
} from "./config.js";

// ── constants ────────────────────────────────────────────────────────

const SECRETS_FILE = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "secrets",
  "github.json",
);

const GITHUB_API = "https://api.github.com";

export const LATEST_SYNC_INTERVAL_MS = 30_000;
export const RUNS_SYNC_INTERVAL_MS = 5 * 60_000;

// ── Nerd Font icons for run/job statuses (ADR 0004 reconciled set) ───

export const GH_ICONS: Record<string, string> = {
  success: "\uF14A",         // nf-fa-check_circle
  failure: "\uF00D",         // nf-fa-times_circle
  in_progress: "\uF110",     // nf-fa-spinner
  queued: "\uF254",          // nf-fa-hourglass_half
  cancelled: "\uF057",       // nf-fa-times_circle
  skipped: "\uF04B",         // nf-fa-fast_forward
  timed_out: "\uF253",       // nf-fa-hourglass_3 (avoid F017 collision with Daily Total)
  action_required: "\uF06A", // nf-fa-exclamation_triangle
  neutral: "\uF059",         // nf-fa-question_circle
  stale: "\uF0EC",           // nf-fa-exchange
  pending: "\uF254",         // nf-fa-hourglass_half (same as queued)
  waiting: "\uF254",         // nf-fa-hourglass_half (same as queued)
  no_runs: "\uF05E",         // nf-fa-check_circle (zero-state)
  auth_error: "\uF06A",      // nf-fa-exclamation_triangle
  api_error: "\uF06A",       // nf-fa-exclamation_triangle
};

/** Hex colors for each run/job status (ADR 0004). */
export const GH_COLORS: Record<string, string> = {
  success: "#22C55E",
  failure: "#EF4444",
  in_progress: "#F59E0B",
  queued: "#9CA3AF",
  cancelled: "#9CA3AF",
  skipped: "#6B7280",
  timed_out: "#EF4444",
  action_required: "#F59E0B",
  neutral: "#9CA3AF",
  stale: "#9CA3AF",
  pending: "#9CA3AF",
  waiting: "#9CA3AF",
};

/** Labels for each status/conclusion used in the widget and overlay. */
export const GH_LABELS: Record<string, string> = {
  success: "Passing",
  failure: "Failing",
  in_progress: "Running",
  queued: "Queued",
  cancelled: "Cancelled",
  skipped: "Skipped",
  timed_out: "Timed out",
  action_required: "Needs action",
  neutral: "Neutral",
  stale: "Stale",
  pending: "Queued",
  waiting: "Queued",
};

// ── git remote resolution ────────────────────────────────────────────

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export type RemoteError =
  | "not_a_git_repo"
  | "no_github_remote"
  | "no_origin_remote"
  | "unrecognized_url_format"
  | "not_a_github_repo";

export interface RemoteResult {
  ok: true;
  repo: GitHubRepo;
  remoteName: string;
}

export interface RemoteErr {
  ok: false;
  error: RemoteError;
  detail: string;
}

/**
 * Resolve `owner/repo` from the git remote of the given working directory.
 *
 * Strategy:
 * 1. `git remote get-url origin` — prefer origin, the convention remote.
 * 2. If no origin: list all remotes and pick the first alphabetically.
 *    If zero remotes: return no_github_remote.
 * 3. Parse the URL: supports HTTPS (https://github.com/owner/repo.git)
 *    and SSH (git@github.com:owner/repo.git).
 * 4. Validate the host is github.com — if not, return not_a_github_repo.
 */
export function resolveGitHubRepo(cwd: string): RemoteResult | RemoteErr {
  const originUrl = getRemoteUrl(cwd, "origin");

  if (originUrl !== null) {
    return parseGitHubUrl(originUrl, "origin");
  }

  // No origin — try the first available remote
  const remotes = listRemotes(cwd);
  if (remotes.length === 0) {
    const gitDir = findGitDir(cwd);
    if (gitDir === null) {
      return { ok: false, error: "not_a_git_repo", detail: `No .git directory found above ${cwd}` };
    }
    return { ok: false, error: "no_github_remote", detail: "Repository has no remotes configured." };
  }

  // Check each remote for a GitHub URL
  for (const name of remotes) {
    const url = getRemoteUrl(cwd, name);
    if (url) {
      const parsed = parseGitHubUrl(url, name);
      if (parsed.ok) return parsed;
    }
  }

  return { ok: false, error: "no_github_remote", detail: `None of the configured remotes (${remotes.join(", ")}) point to GitHub.` };
}

// ── helpers ──────────────────────────────────────────────────────────

function getRemoteUrl(cwd: string, remote: string): string | null {
  try {
    const out = cp.execSync(`git remote get-url ${remote}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const url = out.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

function listRemotes(cwd: string): string[] {
  try {
    const out = cp.execSync("git remote", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = out.trim().split("\n").filter((l) => l.length > 0);
    return lines.sort();
  } catch {
    return [];
  }
}

function findGitDir(cwd: string): string | null {
  try {
    const out = cp.execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// ── URL parsing ──────────────────────────────────────────────────────

/**
 * Parse a git remote URL into a GitHubRepo (owner/repo).
 * Supports:
 *   - HTTPS: https://github.com/owner/repo.git  (and without .git)
 *   - SSH:   git@github.com:owner/repo.git       (and without .git)
 */
function parseGitHubUrl(url: string, remoteName: string): RemoteResult | RemoteErr {
  // Strip trailing .git
  let cleaned = url.trim();
  if (cleaned.endsWith(".git")) {
    cleaned = cleaned.slice(0, -4);
  }

  // HTTPS format: https://github.com/owner/repo
  const httpsMatch = cleaned.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/|$)/i);
  if (httpsMatch) {
    return {
      ok: true,
      repo: { owner: httpsMatch[1], repo: httpsMatch[2] },
      remoteName,
    };
  }

  // SSH format: git@github.com:owner/repo
  const sshMatch = cleaned.match(/^git@github\.com:([^/]+)\/([^/]+?)$/i);
  if (sshMatch) {
    return {
      ok: true,
      repo: { owner: sshMatch[1], repo: sshMatch[2] },
      remoteName,
    };
  }

  // Other formats that point to GitHub (e.g. ssh://git@github.com/owner/repo)
  const altMatch = cleaned.match(/^[a-z]+:\/\/.*github\.com[:\/]([^/]+)\/([^/]+?)(?:\/|$)/i);
  if (altMatch) {
    return {
      ok: true,
      repo: { owner: altMatch[1], repo: altMatch[2] },
      remoteName,
    };
  }

  // URL format we don't recognize
  if (url.includes("github.com")) {
    return { ok: false, error: "unrecognized_url_format", detail: `Remote "${remoteName}" URL contains github.com but couldn't parse owner/repo from: ${url}` };
  }

  return { ok: false, error: "not_a_github_repo", detail: `Remote "${remoteName}" does not point to GitHub: ${url}` };
}

// ── token ─────────────────────────────────────────────────────────────

export function loadGitHubToken(): string | null {
  try {
    const raw = fs.readFileSync(SECRETS_FILE, "utf-8");
    const data = JSON.parse(raw);
    return typeof data.token === "string" && data.token.length > 0
      ? data.token
      : null;
  } catch {
    return null;
  }
}

export function saveGitHubToken(token: string): void {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify({ token }, null, 2), "utf-8");
}

// ── API fetch ─────────────────────────────────────────────────────────

export interface ResolvedGitHubConfig {
  token: string;
  owner: string;
  repo: string;
}

/**
 * Combine token + remote resolution into a ready-to-use config.
 * Returns null when GitHub isn't available (no token, no git remote, etc.).
 * Returns { ok: false, error } for explicit error states (auth failure).
 */
export function resolveGitHubConfig(
  cwd: string,
): { ok: true; config: ResolvedGitHubConfig } | { ok: false; reason: string } {
  const token = loadGitHubToken();
  if (!token) {
    return { ok: false, reason: "no_token" };
  }

  // Check for repo_override in dev config
  const devCfg = loadDevConfig(cwd);
  if (devCfg.github?.repo_override) {
    const [owner, repo] = devCfg.github.repo_override.split("/");
    if (owner && repo) {
      return { ok: true, config: { token, owner, repo } };
    }
    return { ok: false, reason: "invalid_repo_override" };
  }

  const remote = resolveGitHubRepo(cwd);
  if (!remote.ok) {
    return { ok: false, reason: remote.error };
  }

  return {
    ok: true,
    config: { token, owner: remote.repo.owner, repo: remote.repo.repo },
  };
}

async function ghApiFetch(
  config: ResolvedGitHubConfig,
  apiPath: string,
): Promise<
  { ok: true; data: unknown } | { ok: false; error: string; status: number }
> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  let resp: Response;
  try {
    resp = await fetch(`${GITHUB_API}${apiPath}`, { headers });
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: 0,
    };
  }

  if (!resp.ok) {
    let body = "";
    try {
      body = await resp.text();
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: `HTTP ${resp.status}: ${body.slice(0, 300)}`,
      status: resp.status,
    };
  }

  const data = await resp.json();
  return { ok: true, data };
}

function slimRun(raw: Record<string, unknown>): GitHubRun {
  const actor = raw.actor as Record<string, unknown> | undefined;
  return {
    id: raw.id as number,
    name: (raw.name as string) ?? null,
    display_title: (raw.display_title as string) ?? "",
    status: (raw.status as string) ?? null,
    conclusion: (raw.conclusion as string) ?? null,
    head_branch: (raw.head_branch as string) ?? null,
    event: (raw.event as string) ?? "",
    run_number: raw.run_number as number,
    workflow_id: raw.workflow_id as number,
    created_at: (raw.created_at as string) ?? "",
    updated_at: (raw.updated_at as string) ?? "",
    run_started_at: (raw.run_started_at as string) ?? "",
    actor_login: (actor?.login as string) ?? "",
    html_url: (raw.html_url as string) ?? "",
  };
}

function slimJob(raw: Record<string, unknown>): GitHubJob {
  const stepsRaw = (raw.steps as Array<Record<string, unknown>>) ?? [];
  return {
    id: raw.id as number,
    run_id: raw.run_id as number,
    name: (raw.name as string) ?? "",
    status: (raw.status as string) ?? "",
    conclusion: (raw.conclusion as string) ?? null,
    started_at: (raw.started_at as string) ?? "",
    completed_at: (raw.completed_at as string) ?? null,
    steps: stepsRaw.map((s) => ({
      name: (s.name as string) ?? "",
      status: (s.status as string) ?? "",
      conclusion: (s.conclusion as string) ?? null,
      number: s.number as number,
      started_at: (s.started_at as string) ?? null,
      completed_at: (s.completed_at as string) ?? null,
    })),
  };
}

export async function fetchLatestRun(
  config: ResolvedGitHubConfig,
): Promise<GitHubLatestCache> {
  const res = await ghApiFetch(
    config,
    `/repos/${config.owner}/${config.repo}/actions/runs?per_page=1`,
  );

  const now = new Date().toISOString();
  if (!res.ok) {
    return {
      fetched_at: now,
      owner: config.owner,
      repo: config.repo,
      run: null, // API error — consumer checks fetched_at age
    };
  }

  const data = res.data as {
    workflow_runs?: Array<Record<string, unknown>>;
    total_count?: number;
  };

  const runs = data.workflow_runs ?? [];
  const run = runs.length > 0 ? slimRun(runs[0]) : null;

  return {
    fetched_at: now,
    owner: config.owner,
    repo: config.repo,
    run,
  };
}

export async function fetchActionsRuns(
  config: ResolvedGitHubConfig,
): Promise<{ ok: true; cache: GitHubActionsCache } | { ok: false; error: string }> {
  const res = await ghApiFetch(
    config,
    `/repos/${config.owner}/${config.repo}/actions/runs?per_page=30`,
  );

  if (!res.ok) {
    return { ok: false, error: res.error };
  }

  const data = res.data as {
    workflow_runs?: Array<Record<string, unknown>>;
    total_count?: number;
  };

  const cache: GitHubActionsCache = {
    fetched_at: new Date().toISOString(),
    owner: config.owner,
    repo: config.repo,
    total_count: data.total_count ?? 0,
    runs: (data.workflow_runs ?? []).map(slimRun),
  };

  return { ok: true, cache };
}

export async function fetchRunJobs(
  config: ResolvedGitHubConfig,
  runId: number,
): Promise<{ ok: true; detail: GitHubJobsDetail } | { ok: false; error: string }> {
  const res = await ghApiFetch(
    config,
    `/repos/${config.owner}/${config.repo}/actions/runs/${runId}/jobs`,
  );

  if (!res.ok) {
    return { ok: false, error: res.error };
  }

  const data = res.data as {
    jobs?: Array<Record<string, unknown>>;
    total_count?: number;
  };

  const detail: GitHubJobsDetail = {
    fetched_at: new Date().toISOString(),
    run_id: runId,
    total_count: data.total_count ?? 0,
    jobs: (data.jobs ?? []).map(slimJob),
  };

  return { ok: true, detail };
}

/** Fetch the authenticated GitHub user login (for "my" filter). */
export async function fetchGitHubUser(
  config: ResolvedGitHubConfig,
): Promise<string | null> {
  const res = await ghApiFetch(config, "/user");
  if (!res.ok) return null;
  const data = res.data as { login?: string };
  return data.login ?? null;
}

// ── widget status helper ─────────────────────────────────────────────

/**
 * Build a GitHubWidgetStatus from the cached latest run, adding error
 * state when the cache is stale or absent.
 */
export async function fetchWidgetStatus(
  cwd: string,
  config: ResolvedGitHubConfig,
): Promise<GitHubWidgetStatus> {
  const cache = await fetchLatestRun(config);

  // Check if API returned data (run=null means 0 runs, error, or empty)
  // Distinguish: if fetched_at is stale (>2x sync interval = 60s), treat as API error
  const cacheAge = Date.now() - new Date(cache.fetched_at).getTime();
  if (cacheAge > 60_000 && cache.run === null) {
    // We tried but got no data — could be auth or API
    return { run: null, error: "api" };
  }

  // Write cache
  writeLatestCache(cwd, cache);

  return { run: cache.run ?? null, error: null };
}

// ── interactive setup ────────────────────────────────────────────────

export async function ensureGitHubSetup(ctx: {
  hasUI: boolean;
  ui: {
    input(p: string): Promise<string | undefined>;
    notify(m: string, t?: string): void;
  };
  cwd: string;
}): Promise<ResolvedGitHubConfig | null> {
  if (!ctx.hasUI) {
    console.log(
      "=== /actions ===\n" +
        "To use this command interactively, run pi without --print/-p.\n\n" +
        "Manual setup:\n" +
        `  1. Save your GitHub PAT to ${SECRETS_FILE}:\n` +
        '     { "token": "ghp_..." }\n' +
        "     (requires actions:read scope for fine-grained tokens)\n" +
        "  2. Run /actions from a repo with a GitHub remote (origin or first remote)\n" +
        "  3. Or override: add { \"github\": { \"repo_override\": \"owner/repo\" } } to .dev/config.json\n",
    );
    return null;
  }

  let token = loadGitHubToken();
  if (!token) {
    const input = await ctx.ui.input(
      "Enter your GitHub Personal Access Token (Settings > Developer settings > PAT, scope: actions:read):",
    );
    if (!input || input.trim().length === 0) {
      ctx.ui.notify("No token provided — aborting.", "error");
      return null;
    }
    token = input.trim();
    saveGitHubToken(token);
    ctx.ui.notify(
      "Token saved to ~/.pi/agent/secrets/github.json",
      "info",
    );
  }

  // Check if remote resolution works
  const resolved = resolveGitHubConfig(ctx.cwd);
  if (!resolved.ok) {
    // Offer repo_override
    const overrideInput = await ctx.ui.input(
      `Could not resolve a GitHub remote (${resolved.reason}). Enter an owner/repo override (e.g. "myorg/myrepo") or press Esc to cancel:`,
    );
    if (!overrideInput || overrideInput.trim().length === 0) {
      ctx.ui.notify("No repo override — aborting.", "error");
      return null;
    }
    const parts = overrideInput.trim().split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      ctx.ui.notify("Invalid format. Use owner/repo (e.g. myorg/myrepo).", "error");
      return null;
    }

    // Save repo_override to dev config
    const devCfg = loadDevConfig(ctx.cwd);
    devCfg.github = { ...devCfg.github, repo_override: overrideInput.trim() };
    saveDevConfig(ctx.cwd, devCfg);
    ctx.ui.notify("Repo override saved to .dev/config.json", "info");

    return { token, owner: parts[0], repo: parts[1] };
  }

  return resolved.config;
}

// ── format helpers ────────────────────────────────────────────────────

export function formatRelativeTime(isoString: string): string {
  const then = new Date(isoString).getTime();
  const now = Date.now();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  // Beyond 30 days, show date
  return new Date(isoString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * Format an elapsed duration (for running items).
 * Matches the Existing Elapsed style: Xh Ym Zs with zero units dropped.
 */
export function formatElapsed(startIso: string): string {
  const startMs = new Date(startIso).getTime();
  const diffMs = Date.now() - startMs;

  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(" ");
}
