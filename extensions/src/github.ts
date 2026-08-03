import * as fs from "node:fs";
import * as cp from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

// ── constants ────────────────────────────────────────────────────────

const SECRETS_FILE = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "secrets",
  "github.json",
);

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

// (stub — will be filled in when data model ticket is resolved)

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
