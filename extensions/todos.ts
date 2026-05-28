import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as cp from "node:child_process";
import { Type } from "typebox";
import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

// ── constants ────────────────────────────────────────────────────────

const PLANE_API_BASE = "https://api.plane.so/api/v1";
const SECRETS_FILE = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "secrets",
  "plane.json",
);
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CURRENT_VERSION_FALLBACK = "1.0.1";
const VERSION_CHECK_TIMEOUT_MS = 5000;

// State groups to exclude — only "completed" means done
const COMPLETED_GROUPS = new Set(["completed"]);

// Canonical group sort order for widget pills
const GROUP_ORDER = ["backlog", "unstarted", "started", "triage", "cancelled"];

// ── hex to ANSI true-color foreground ─────────────────────────────

function hexToAnsi(hex: string, text: string): string {
  // Strip # and parse RRGGBB
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return text;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

// ── priority color mapping ───────────────────────────────────────

const PRIORITY_COLORS: Record<string, string> = {
  urgent: "#EF4444",
  high: "#F59E0B",
  medium: "#EAB308",
  low: "#3B82F6",
  none: "#9CA3AF",
};

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

function priorityLabel(priority: string): string {
  const label = priority || "none";
  const hex = PRIORITY_COLORS[label] ?? PRIORITY_COLORS.none;
  return hexToAnsi(hex, label);
}

// ── duration formatting ──────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

// ── version check ────────────────────────────────────────────────

function getOwnPackageJson(): Record<string, unknown> | null {
  try {
    const pkgPath = path.join(
      os.homedir(),
      ".pi",
      "agent",
      "git",
      "github.com",
      "WaldoJoubert-GH",
      "pi-todos",
      "package.json",
    );
    return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
}

function getCurrentVersion(): string {
  const pkg = getOwnPackageJson();
  if (pkg && typeof pkg.version === "string") return pkg.version;
  return CURRENT_VERSION_FALLBACK;
}

function getPackageRepoUrl(): string | null {
  const pkg = getOwnPackageJson();
  if (!pkg) return null;
  const repo = pkg.repository;
  if (repo && typeof repo === "object" && repo !== null && "url" in repo) {
    const url: unknown = (repo as Record<string, unknown>).url;
    if (typeof url === "string" && url.length > 0) return url;
  }
  return null;
}

function isSemverNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < Math.max(av.length, bv.length, 3); i++) {
    const an = av[i] || 0;
    const bn = bv[i] || 0;
    if (an !== bn) return an > bn;
  }
  return false;
}

async function checkForUpdate(): Promise<void> {
  try {
    const currentVersion = getCurrentVersion();
    const repoUrl = getPackageRepoUrl();
    if (!repoUrl) return;

    const gitUrl = repoUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "");

    const result = cp.execSync(`git ls-remote --tags https://${gitUrl}`, {
      timeout: VERSION_CHECK_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    let latestVersion = currentVersion;
    const tagRe = /refs\/tags\/(v?\d+\.\d+\.\d+)$/m;
    for (const line of result.trim().split("\n")) {
      if (!line) continue;
      const match = line.match(tagRe);
      if (!match) continue;
      const tag = match[1];
      if (isSemverNewer(tag, latestVersion)) {
        latestVersion = tag;
      }
    }

    if (latestVersion !== currentVersion) {
      updateAvailableVersion = latestVersion;
    }
  } catch {
    // Silent failure
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

// ── types ────────────────────────────────────────────────────────────

interface CachedIssue {
  id: string;
  sequence_id: number;
  title: string;
  description: string;
  state_name: string;
  state_group: string;
  state_hex: string;
  priority: string;
  link: string;
}

interface TodoCache {
  last_synced: string;
  workspace_slug: string;
  project_id: string;
  issues: CachedIssue[];
  states: Record<string, { count: number; color: string; group: string }>;
  total_active: number;
  sync_error?: boolean;
}

interface TimeEntry {
  issue_id: string;
  sequence_id: number;
  title: string;
  started_at: string;
  stopped_at: string | null;
}

interface TimeEntryStore {
  entries: TimeEntry[];
}

interface ProjectConfig {
  workspace_slug: string;
  project_id: string;
  project_identifier?: string;
}

interface RawIssue {
  id: string;
  name: string;
  sequence_id: number;
  state: string; // UUID
  assignees: string[]; // UUIDs
  priority: string;
  completed_at: string | null;
  created_at: string;
  project: string;
  workspace: string;
  is_draft: boolean;
  description_html?: string;
  description_stripped?: string;
}

interface RawState {
  id: string;
  name: string;
  group: string;
  color: string;
}

// ── token helpers ────────────────────────────────────────────────────

function loadToken(): string | null {
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

function saveToken(token: string): void {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify({ token }, null, 2), "utf-8");
}

// ── config helpers ───────────────────────────────────────────────────

function loadProjectConfig(cwd: string): ProjectConfig | null {
  try {
    const raw = fs.readFileSync(
      path.join(cwd, ".todo", "config.json"),
      "utf-8",
    );
    const data: Record<string, unknown> = JSON.parse(raw);
    if (
      typeof data.workspace_slug !== "string" ||
      typeof data.project_id !== "string"
    ) {
      return null;
    }
    return {
      workspace_slug: data.workspace_slug,
      project_id: data.project_id,
      project_identifier:
        typeof data.project_identifier === "string"
          ? data.project_identifier
          : undefined,
    };
  } catch {
    return null;
  }
}

function saveProjectConfig(cwd: string, cfg: ProjectConfig): void {
  const dir = path.join(cwd, ".todo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify(cfg, null, 2),
    "utf-8",
  );
}

// ── time entry store helpers ─────────────────────────────────────

function timeEntryStorePath(cwd: string): string {
  return path.join(cwd, ".todo", "time-entries.json");
}

function loadTimeEntries(cwd: string): TimeEntry[] {
  try {
    const raw = fs.readFileSync(timeEntryStorePath(cwd), "utf-8");
    const store = JSON.parse(raw) as TimeEntryStore;
    return Array.isArray(store.entries) ? store.entries : [];
  } catch {
    return [];
  }
}

function saveTimeEntries(cwd: string, entries: TimeEntry[]): void {
  const file = timeEntryStorePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ entries }, null, 2), "utf-8");
}

// ── time entry management ───────────────────────────────────────

function getRunningEntry(entries: TimeEntry[]): TimeEntry | null {
  return entries.find((e) => e.stopped_at === null) ?? null;
}

function getAccumulatedMs(entries: TimeEntry[], issueId: string): number {
  let total = 0;
  for (const e of entries) {
    if (e.issue_id !== issueId) continue;
    const start = new Date(e.started_at).getTime();
    const end = e.stopped_at ? new Date(e.stopped_at).getTime() : Date.now();
    total += end - start;
  }
  return total;
}

function startTimeEntry(entries: TimeEntry[], issue: CachedIssue, cwd: string): void {
  const now = new Date().toISOString();
  // Stop any existing running entry first
  for (const e of entries) {
    if (e.stopped_at === null) {
      e.stopped_at = now;
    }
  }
  entries.push({
    issue_id: issue.id,
    sequence_id: issue.sequence_id,
    title: issue.title,
    started_at: now,
    stopped_at: null,
  });
  saveTimeEntries(cwd, entries);
}

function stopRunningEntry(entries: TimeEntry[], cwd: string): void {
  const now = new Date().toISOString();
  for (const e of entries) {
    if (e.stopped_at === null) {
      e.stopped_at = now;
    }
  }
  saveTimeEntries(cwd, entries);
}

// ── cache helpers ────────────────────────────────────────────────────

function cachePath(cwd: string): string {
  return path.join(cwd, ".todo", "cache.json");
}

function loadCache(cwd: string): TodoCache | null {
  try {
    const raw = fs.readFileSync(cachePath(cwd), "utf-8");
    return JSON.parse(raw) as TodoCache;
  } catch {
    return null;
  }
}

function writeCache(cwd: string, cache: TodoCache): void {
  const file = cachePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2), "utf-8");
}

// ── fetch wrappers ───────────────────────────────────────────────────

type ApiOk<T> = { ok: true; status: number; data: T };
type ApiErr = { ok: false; status: number; body: string };
type ApiResult<T> = ApiOk<T> | ApiErr;

async function fetchProjectIdentifier(
  config: ProjectConfig,
  token: string,
): Promise<string | null> {
  const url = `${PLANE_API_BASE}/workspaces/${config.workspace_slug}/projects/${config.project_id}/`;
  const result = await apiFetch<{ identifier?: string }>(url, token);
  if (!result.ok) return null;
  return result.data.identifier ?? null;
}

async function apiFetch<T>(url: string, token: string): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { "X-Api-Key": token } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: `Network error: ${msg}` };
  }
  if (!response.ok) {
    let body = "(no body)";
    try {
      body = await response.text();
    } catch {
      /* ignore */
    }
    return { ok: false, status: response.status, body: body.slice(0, 500) };
  }
  let data: T;
  try {
    data = (await response.json()) as T;
  } catch {
    return { ok: false, status: response.status, body: "Failed to parse JSON" };
  }
  return { ok: true, status: response.status, data };
}

// ── fetch lookup maps ────────────────────────────────────────────────

async function fetchStateMap(
  config: ProjectConfig,
  token: string,
): Promise<Map<string, { name: string; group: string; color: string }>> {
  const url = `${PLANE_API_BASE}/workspaces/${config.workspace_slug}/projects/${config.project_id}/states/`;
  const result = await apiFetch<{ results?: RawState[] }>(url, token);
  if (!result.ok) return new Map();

  const map = new Map<string, { name: string; group: string; color: string }>();
  for (const s of result.data.results ?? []) {
    map.set(s.id, {
      name: s.name,
      group: s.group,
      color: s.color || "#808080",
    });
  }
  return map;
}

// ── ensureSetup ──────────────────────────────────────────────────────

async function ensureSetup(ctx: {
  hasUI: boolean;
  ui: {
    input(p: string): Promise<string | undefined>;
    notify(m: string, t?: string): void;
  };
  cwd: string;
}): Promise<{ token: string; config: ProjectConfig } | null> {
  if (!ctx.hasUI) {
    console.log(
      "=== /todos ===\n" +
        "To use this command interactively, run pi without --print/-p.\n\n" +
        "Manual setup:\n" +
        `  1. Save your Plane PAT to ${SECRETS_FILE}:\n` +
        '     { "token": "pt_..." }\n' +
        "  2. Create .todo/config.json in the project root:\n" +
        '     { "workspace_slug": "...", "project_id": "..." }\n',
    );
    return null;
  }

  let token = loadToken();
  if (!token) {
    const input = await ctx.ui.input(
      "Enter your Plane.so Personal Access Token:",
    );
    if (!input || input.trim().length === 0) {
      ctx.ui.notify("No token provided — aborting.", "error");
      return null;
    }
    token = input.trim();
    saveToken(token);
    ctx.ui.notify("Token saved to ~/.pi/agent/secrets/plane.json", "info");
  }

  let config = loadProjectConfig(ctx.cwd);
  if (!config) {
    const slug = await ctx.ui.input("Enter your Plane workspace slug:");
    if (!slug || slug.trim().length === 0) {
      ctx.ui.notify("No workspace slug — aborting.", "error");
      return null;
    }
    const pid = await ctx.ui.input("Enter your Plane project ID (UUID):");
    if (!pid || pid.trim().length === 0) {
      ctx.ui.notify("No project ID — aborting.", "error");
      return null;
    }
    config = { workspace_slug: slug.trim(), project_id: pid.trim() };
    saveProjectConfig(ctx.cwd, config);
    ctx.ui.notify("Config saved to .todo/config.json", "info");
  }

  return { token, config };
}

// ── fetch and build cache ────────────────────────────────────────────

async function buildCache(
  config: ProjectConfig,
  token: string,
): Promise<{ cache: TodoCache | null; error: string | null }> {
  // Fetch issues
  const issuesUrl = `${PLANE_API_BASE}/workspaces/${config.workspace_slug}/projects/${config.project_id}/issues/?per_page=1000`;
  const [issuesResult, stateMap] = await Promise.all([
    apiFetch<{ results?: RawIssue[] }>(issuesUrl, token),
    fetchStateMap(config, token),
  ]);

  if (!issuesResult.ok) {
    return {
      cache: null,
      error: `Plane API error: ${issuesResult.status} ${issuesResult.body}`,
    };
  }

  const all = issuesResult.data.results ?? [];
  const active = all.filter((issue) => {
    const stateObj = issue.state ? stateMap.get(issue.state) : undefined;
    if (!stateObj) return true;
    return !COMPLETED_GROUPS.has(stateObj.group);
  });

  const statesAcc: Record<
    string,
    { count: number; color: string; group: string }
  > = {};

  const issues: CachedIssue[] = active.map((issue) => {
    const stateObj = issue.state ? stateMap.get(issue.state) : undefined;
    const group = stateObj?.group ?? "unknown";
    const stateName = stateObj?.name ?? "Unknown";
    const stateHex = stateObj?.color ?? "#808080";

    // Accumulate per-state counts
    if (!statesAcc[stateName]) {
      statesAcc[stateName] = { count: 0, color: stateHex, group };
    }
    statesAcc[stateName].count++;

    const priority = issue.priority || "none";

    const link = `https://app.plane.so/${config.workspace_slug}/projects/${config.project_id}/issues/${issue.id}`;

    const description =
      issue.description_stripped ??
      stripHtml(issue.description_html ?? "") ??
      "";

    return {
      id: issue.id,
      sequence_id: issue.sequence_id,
      title: issue.name,
      description,
      state_name: stateName,
      state_group: group,
      state_hex: stateHex,
      priority,
      link,
    };
  });

  // Sort: priority (urgent first) → state group → title alpha
  const GROUP_SORT: Record<string, number> = {
    backlog: 0,
    unstarted: 1,
    started: 2,
    triage: 3,
    cancelled: 4,
  };
  issues.sort((a, b) => {
    const pA = PRIORITY_ORDER[a.priority] ?? 99;
    const pB = PRIORITY_ORDER[b.priority] ?? 99;
    if (pA !== pB) return pA - pB;
    const gA = GROUP_SORT[a.state_group] ?? 99;
    const gB = GROUP_SORT[b.state_group] ?? 99;
    if (gA !== gB) return gA - gB;
    return a.title.localeCompare(b.title);
  });

  const total_active = issues.length;

  const cache: TodoCache = {
    last_synced: new Date().toISOString(),
    workspace_slug: config.workspace_slug,
    project_id: config.project_id,
    issues,
    states: statesAcc,
    total_active,
  };

  return { cache, error: null };
}

// ── widget helpers ───────────────────────────────────────────────────

function buildWidgetLines(
  cache: TodoCache,
  runningEntry: TimeEntry | null,
  missingIssue: boolean,
): string[] {
  const syncIcon = cache.sync_error ? "⚠️ " : "";
  const lines: string[] = [`${syncIcon}✈️: ${cache.total_active}`];

  const pillParts: string[] = [];

  if (cache.states) {
    // New format: per-state pills ordered by group, then alpha
    const entries = Object.entries(cache.states).sort(
      ([nameA, a], [nameB, b]) => {
        const gOrderA = GROUP_ORDER.indexOf(a.group);
        const gOrderB = GROUP_ORDER.indexOf(b.group);
        if (gOrderA !== gOrderB) {
          return (
            (gOrderA === -1 ? 999 : gOrderA) - (gOrderB === -1 ? 999 : gOrderB)
          );
        }
        return nameA.localeCompare(nameB);
      },
    );

    for (const [name, { count, color }] of entries) {
      if (count === 0) continue;
      pillParts.push(`${hexToAnsi(color, name)}: ${count}`);
    }
  } else {
    // Backward compat: old cache with group-level state_counts
    const sc = cache as TodoCache & { state_counts?: Record<string, number> };
    if (sc.state_counts) {
      for (const group of GROUP_ORDER) {
        const count = sc.state_counts[group];
        if (count === undefined || count === 0) continue;
        pillParts.push(`${group}: ${count}`);
      }
    }
  }

  if (pillParts.length > 0) {
    lines.push(pillParts.join("  "));
  }

  // Running entry line
  if (runningEntry) {
    const prefix = missingIssue ? "⚠️ " : "";
    const title =
      runningEntry.title.length > 30
        ? runningEntry.title.slice(0, 29) + "…"
        : runningEntry.title;
    const elapsed = formatDuration(
      Date.now() - new Date(runningEntry.started_at).getTime(),
    );
    lines.push(`${prefix}⏱ #${runningEntry.sequence_id} ${title} — ${elapsed}`);
  }

  // Update available pill
  if (updateAvailableVersion) {
    const repoUrl = getPackageRepoUrl();
    const installCmd = repoUrl
      ? `pi install ${repoUrl}@${updateAvailableVersion}`
      : `pi install git:github.com/WaldoJoubert-GH/pi-todos@${updateAvailableVersion}`;
    lines.push(`🔔 pi-todos ${updateAvailableVersion} available — ${installCmd}`);
  }

  return lines;
}

// ── strip HTML ─────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// ── overlay component ────────────────────────────────────────────────

class TodoOverlay {
  private issues: CachedIssue[] = [];
  private selected = 0;
  private scrollOffset = 0;
  private visibleHeight = 0;
  private detailIssue: CachedIssue | null = null;
  private detailScroll = 0;
  private projectIdentifier: string | null;
  private theme: {
    fg: (color: string, text: string) => string;
    bg: (color: string, text: string) => string;
  };
  private onClose: () => void;
  private onToggleTime: (issue: CachedIssue) => void;
  private getRunningEntryId: () => string | null;
  private getAccumulatedMsFn: (issueId: string) => number;
  private getTimeEntriesForIssue: (issueId: string) => TimeEntry[];

  constructor(
    issues: CachedIssue[],
    theme: {
      fg: (color: string, text: string) => string;
      bg: (color: string, text: string) => string;
    },
    onClose: () => void,
    projectIdentifier: string | null,
    onToggleTime: (issue: CachedIssue) => void,
    getRunningEntryId: () => string | null,
    getAccumulatedMsFn: (issueId: string) => number,
    getTimeEntriesForIssue: (issueId: string) => TimeEntry[],
  ) {
    this.issues = issues;
    this.theme = theme;
    this.onClose = onClose;
    this.projectIdentifier = projectIdentifier;
    this.onToggleTime = onToggleTime;
    this.getRunningEntryId = getRunningEntryId;
    this.getAccumulatedMsFn = getAccumulatedMsFn;
    this.getTimeEntriesForIssue = getTimeEntriesForIssue;
  }

  updateIssues(issues: CachedIssue[]): void {
    this.issues = issues;
    this.selected = 0;
    this.scrollOffset = 0;
    this.detailIssue = null;
    this.detailScroll = 0;
  }

  handleInput(data: string): void {
    // Ctrl+Enter → open URL (works in both list and detail views)
    if (matchesKey(data, Key.ctrl("enter"))) {
      const issue = this.detailIssue ?? this.issues[this.selected];
      if (issue) {
        openUrl(issue.link);
      }
      return;
    }

    // c → copy issue identifier (works in both list and detail views)
    if (matchesKey(data, "c")) {
      const issue = this.detailIssue ?? this.issues[this.selected];
      if (issue) {
        const id = this.projectIdentifier
          ? `${this.projectIdentifier}-${issue.sequence_id}`
          : `#${issue.sequence_id}`;
        copyToClipboard(id);
      }
      return;
    }

    // s → toggle time entry (works in both list and detail views)
    if (matchesKey(data, "s")) {
      const issue = this.detailIssue ?? this.issues[this.selected];
      if (issue) {
        this.onToggleTime(issue);
      }
      return;
    }

    // Detail view key handling
    if (this.detailIssue !== null) {
      if (matchesKey(data, Key.escape)) {
        this.detailIssue = null;
        this.detailScroll = 0;
      } else if (matchesKey(data, Key.down) || matchesKey(data, Key.pageDown)) {
        this.detailScroll++;
      } else if (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp)) {
        this.detailScroll = Math.max(0, this.detailScroll - 1);
      } else if (matchesKey(data, Key.home)) {
        this.detailScroll = 0;
      }
      return;
    }

    // List view key handling
    if (matchesKey(data, Key.up)) {
      if (this.selected > 0) {
        this.selected--;
        this.ensureVisible();
      }
    } else if (matchesKey(data, Key.down)) {
      if (this.selected < this.issues.length - 1) {
        this.selected++;
        this.ensureVisible();
      }
    } else if (matchesKey(data, Key.enter)) {
      const issue = this.issues[this.selected];
      if (issue) {
        this.detailIssue = issue;
        this.detailScroll = 0;
      }
    } else if (matchesKey(data, Key.escape)) {
      this.onClose();
    } else if (matchesKey(data, Key.home)) {
      this.selected = 0;
      this.scrollOffset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.selected = this.issues.length - 1;
      this.ensureVisible();
    } else if (matchesKey(data, Key.pageUp)) {
      this.selected = Math.max(0, this.selected - this.visibleHeight);
      this.ensureVisible();
    } else if (matchesKey(data, Key.pageDown)) {
      const max = this.issues.length - 1;
      this.selected = Math.min(max, this.selected + this.visibleHeight);
      this.ensureVisible();
    }
  }

  private ensureVisible(): void {
    if (this.selected < this.scrollOffset) {
      this.scrollOffset = this.selected;
    } else if (this.selected >= this.scrollOffset + this.visibleHeight) {
      this.scrollOffset = this.selected - this.visibleHeight + 1;
    }
  }

  render(width: number): string[] {
    // ── detail view ──────────────────────────────────────────────────
    if (this.detailIssue) {
      return this.renderDetail(width);
    }

    const lines: string[] = [];
    const t = this.theme;
    const B = (s: string) => t.fg("border", s);
    const innerW = Math.max(1, width - 2);

    // ── top border with embedded title ───────────────────────────────
    const title = `✈️  Todos (${this.issues.length}) `;
    const topDash = Math.max(0, innerW - title.length - 3);
    lines.push(
      B("┌─ ") + t.fg("accent", title) + B(" " + "─".repeat(topDash) + "┐"),
    );

    // ── header row ───────────────────────────────────────────────────
    const slugW = 14;
    const stateW = 12;
    const priorityW = 8;
    const gapW = 6; // 3 gaps × 2 spaces
    const headerTitleW = innerW - slugW - stateW - priorityW - gapW;
    const rowTitleW = headerTitleW - 1; // rows have " " or ">" prefix that steals 1 char

    if (headerTitleW < 10) {
      // Terminal too narrow — minimal view with border
      const narrowTitle = padOrTrunc("Terminal too narrow", innerW);
      lines.push(B("│") + t.fg("muted", narrowTitle) + B("│"));
      const showIssues = this.issues.slice(0, Math.min(10, this.issues.length));
      for (const iss of showIssues) {
        const id = this.projectIdentifier
          ? `${this.projectIdentifier}-${iss.sequence_id}`
          : `#${iss.sequence_id}`;
        const row = padOrTrunc(`${id} ${iss.title}`, innerW);
        lines.push(B("│") + row + B("│"));
      }
      const remaining = this.issues.length - 10;
      if (remaining > 0) {
        const info = padOrTrunc(`… and ${remaining} more`, innerW);
        lines.push(B("│") + t.fg("muted", info) + B("│"));
      }
      lines.push(B("└" + "─".repeat(innerW) + "┘"));
      return lines;
    }

    const header =
      padOrTrunc("ID", slugW) +
      "  " +
      padOrTrunc("Title", headerTitleW) +
      "  " +
      padOrTrunc("State", stateW) +
      "  " +
      padOrTrunc("Priority", priorityW);
    lines.push(B("│") + t.fg("muted", header) + B("│"));

    // ── header-body separator ────────────────────────────────────────
    lines.push(B("├" + "─".repeat(innerW) + "┤"));

    // ── issue rows ───────────────────────────────────────────────────
    const maxVisible = Math.min(25, Math.max(5, Math.floor(innerW * 0.5)));
    this.visibleHeight = maxVisible;

    const endIdx = Math.min(this.scrollOffset + maxVisible, this.issues.length);
    const displayIssues = this.issues.slice(this.scrollOffset, endIdx);

    for (let i = 0; i < displayIssues.length; i++) {
      const idx = this.scrollOffset + i;
      const issue = displayIssues[i];
      const isSelected = idx === this.selected;
      const runningId = this.getRunningEntryId();
      const isTimed = runningId !== null && issue.id === runningId;

      const idStr = this.projectIdentifier
        ? `${this.projectIdentifier}-${issue.sequence_id}`
        : `#${issue.sequence_id}`;
      const slugStr = padOrTrunc(idStr, slugW);
      const titleStr = padOrTrunc(issue.title, rowTitleW);
      const stateStr = padOrTrunc(issue.state_name, stateW);
      const priorityStr = padOrTrunc(issue.priority, priorityW);

      // Color the state text using Plane's per-state hex
      const coloredState = hexToAnsi(issue.state_hex, stateStr);
      const coloredPriority = priorityLabel(issue.priority);

      const timePrefix = isTimed ? "⏱" : isSelected ? ">" : " ";
      const row = `${slugStr}  ${titleStr}  ${coloredState}  ${coloredPriority}`;
      // ANSI codes in coloredState inflate str.length; use visibleWidth for padding
      const rowVis = visibleWidth(`>${row}`);

      if (isSelected) {
        const selectedContent = t.bg(
          "selectedBg",
          t.fg("text", `${timePrefix}${row}`),
        );
        // Pad to innerW so selectedBg fills to the right border
        const padLen = Math.max(0, innerW - rowVis);
        lines.push(B("│") + selectedContent + " ".repeat(padLen) + B("│"));
      } else if (isTimed) {
        // Timed but not selected: use dimmed highlight
        const timedContent = t.bg(
          "selectedBg",
          t.fg("dim", `${timePrefix}${row}`),
        );
        const padLen = Math.max(0, innerW - rowVis);
        lines.push(B("│") + timedContent + " ".repeat(padLen) + B("│"));
      } else {
        // Prefix with space for non-selected; visible width = rowVis (" >row" same as ">row")
        const padLen = Math.max(0, innerW - rowVis);
        lines.push(B("│") + ` ${row}` + " ".repeat(padLen) + B("│"));
      }
    }

    // ── scroll indicator ─────────────────────────────────────────────
    if (endIdx < this.issues.length) {
      const remaining = this.issues.length - endIdx;
      const indicator = padOrTrunc(`↓ ${remaining} more`, innerW);
      lines.push(B("│") + t.fg("muted", indicator) + B("│"));
    }

    // ── body-footer separator ────────────────────────────────────────
    lines.push(B("├" + "─".repeat(innerW) + "┤"));

    // ── footer ───────────────────────────────────────────────────────
    const footer = padOrTrunc(
      "↑↓ scroll  Enter preview  s start/stop  Ctrl+Enter open  c copy ID  Esc close",
      innerW,
    );
    lines.push(B("│") + t.fg("dim", footer) + B("│"));

    // ── bottom border ────────────────────────────────────────────────
    lines.push(B("└" + "─".repeat(innerW) + "┘"));

    return lines;
  }

  private renderDetail(width: number): string[] {
    const t = this.theme;
    const issue = this.detailIssue!;
    const B = (s: string) => t.fg("border", s);
    const innerW = Math.max(1, width - 2);
    const lines: string[] = [];

    // ── top border with embedded title ───────────────────────────────
    const id = this.projectIdentifier
      ? `${this.projectIdentifier}-${issue.sequence_id}`
      : `#${issue.sequence_id}`;
    const title = `✈️ ${id}`;
    const topDash = Math.max(0, innerW - title.length - 3);
    lines.push(
      B("┌─ ") +
        t.bg("selectedBg", t.fg("text", title)) +
        B(" " + "─".repeat(topDash) + "┐"),
    );

    // ── issue title (wrapped) ────────────────────────────────────────
    const titleLines = wrapText(`Title: ${issue.title}`, innerW);
    for (const tl of titleLines) {
      const tlPad = Math.max(0, innerW - visibleWidth(tl));
      lines.push(B("│") + t.fg("accent", tl) + " ".repeat(tlPad) + B("│"));
    }

    // ── meta info ────────────────────────────────────────────────────
    const coloredState = hexToAnsi(issue.state_hex, issue.state_name);
    const coloredPriority = priorityLabel(issue.priority);
    const accMs = this.getAccumulatedMsFn(issue.id);
    const accStr =
      accMs > 0
        ? `  ${t.fg("muted", "· Total:")} ${formatDuration(accMs)}`
        : "";
    const meta = `${coloredState}  ${t.fg("muted", "· Priority: ")}${coloredPriority}${accStr}`;
    const metaPad = Math.max(0, innerW - visibleWidth(meta));
    lines.push(B("│") + meta + " ".repeat(metaPad) + B("│"));

    // ── separator ────────────────────────────────────────────────────
    lines.push(B("├" + "─".repeat(innerW) + "┤"));

    // ── description header ───────────────────────────────────────────
    const descHdr = padOrTrunc("Description:", innerW);
    lines.push(B("│") + t.fg("dim", descHdr) + B("│"));
    // empty line
    lines.push(B("│" + " ".repeat(innerW) + "│"));

    // ── build scrollable content: description + time entries ─────────
    const contentLines: string[] = [];

    // Description text
    const desc = issue.description || "(no description)";
    const descLines = wrapText(desc, innerW);
    for (const dl of descLines) {
      contentLines.push(dl);
    }

    // Time entries table
    const entries = this.getTimeEntriesForIssue(issue.id);
    if (entries.length > 0) {
      contentLines.push(""); // blank separator
      contentLines.push("Time Entries:");

      // Column widths
      const numW = 3;
      const timeW = 13; // MM-DD HH:MM
      const durW = 10;
      const availTableW = innerW - numW - timeW * 2 - durW - 8; // 4 gaps × 2 spaces

      if (availTableW >= 0) {
        // Header row
        const headerRow =
          "#".padEnd(numW + 2) +
          "Started".padEnd(timeW + 2) +
          "Stopped".padEnd(timeW + 2) +
          "Duration";
        contentLines.push(headerRow);

        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const num = String(i + 1).padEnd(numW);
          const started = formatTimestamp(e.started_at);
          const stopped = e.stopped_at
            ? formatTimestamp(e.stopped_at)
            : "(running)";
          const startMs = new Date(e.started_at).getTime();
          const endMs = e.stopped_at
            ? new Date(e.stopped_at).getTime()
            : Date.now();
          const dur = formatDuration(endMs - startMs);
          const row =
            num.padEnd(numW + 2) +
            started.padEnd(timeW + 2) +
            stopped.padEnd(timeW + 2) +
            dur;
          contentLines.push(row);
        }
      } else {
        // Terminal too narrow for table — show compact list
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const started = formatTimestamp(e.started_at);
          const stopped = e.stopped_at
            ? formatTimestamp(e.stopped_at)
            : "running";
          const startMs = new Date(e.started_at).getTime();
          const endMs = e.stopped_at
            ? new Date(e.stopped_at).getTime()
            : Date.now();
          const dur = formatDuration(endMs - startMs);
          contentLines.push(
            `  ${i + 1}. ${started} → ${stopped} (${dur})`,
          );
        }
      }
    }

    // ── scroll through content ───────────────────────────────────────
    // Chrome: top border + title + meta + sep + desc header + empty + sep + footer + bottom border
    const chromeRows = 1 + titleLines.length + 1 + 1 + 1 + 1 + 1 + 1 + 1;
    const viewH =
      this.visibleHeight || Math.min(25, Math.max(5, Math.floor(width * 0.5)));
    const availContentH = Math.max(3, viewH - chromeRows);

    const maxScroll = Math.max(0, contentLines.length - availContentH);
    this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll));

    const endIdx = Math.min(
      this.detailScroll + availContentH,
      contentLines.length,
    );
    for (let i = this.detailScroll; i < endIdx; i++) {
      const cl = contentLines[i];
      const clPad = Math.max(0, innerW - visibleWidth(cl));
      lines.push(B("│") + cl + " ".repeat(clPad) + B("│"));
    }

    if (endIdx < contentLines.length) {
      const indicator = `↓ ${contentLines.length - endIdx} more lines`;
      const indPad = Math.max(0, innerW - indicator.length);
      lines.push(
        B("│") + t.fg("muted", indicator) + " ".repeat(indPad) + B("│"),
      );
    }

    // ── separator ────────────────────────────────────────────────────
    lines.push(B("├" + "─".repeat(innerW) + "┤"));

    // ── footer ───────────────────────────────────────────────────────
    const footer = padOrTrunc(
      "Esc back  s start/stop  ↑↓ scroll  Ctrl+Enter open in browser  c copy ID",
      innerW,
    );
    lines.push(B("│") + t.fg("dim", footer) + B("│"));

    // ── bottom border ────────────────────────────────────────────────
    lines.push(B("└" + "─".repeat(innerW) + "┘"));

    return lines;
  }

  invalidate(): void {
    // no cache to clear
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function padOrTrunc(str: string, len: number): string {
  if (str.length > len) return str.slice(0, len - 1) + "…";
  return str.padEnd(len);
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > width) {
      // Try to break at a space
      let breakAt = remaining.lastIndexOf(" ", width);
      if (breakAt <= 0) breakAt = width;
      lines.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).trimStart();
    }
    if (remaining.length > 0) lines.push(remaining);
  }
  return lines;
}

function openUrl(url: string): void {
  const platform = process.platform;
  if (platform === "win32") {
    cp.exec(`start "" "${url}"`, (err) => {
      if (err) console.error("Failed to open URL:", err.message);
    });
  } else if (platform === "darwin") {
    cp.exec(`open "${url}"`, (err) => {
      if (err) console.error("Failed to open URL:", err.message);
    });
  } else {
    cp.exec(`xdg-open "${url}"`, (err) => {
      if (err) console.error("Failed to open URL:", err.message);
    });
  }
}

function copyToClipboard(text: string): void {
  const platform = process.platform;
  // Escape special characters for shell
  const escaped = text.replace(/'/g, "'\\''");
  if (platform === "win32") {
    cp.exec(`echo|set /p="${text}"| clip`, (err) => {
      if (err) console.error("Failed to copy:", err.message);
    });
  } else if (platform === "darwin") {
    cp.exec(`echo -n '${escaped}' | pbcopy`, (err) => {
      if (err) console.error("Failed to copy:", err.message);
    });
  } else {
    // Try wl-copy first, fall back to xclip
    cp.exec(
      `echo -n '${escaped}' | wl-copy 2>/dev/null || echo -n '${escaped}' | xclip -selection clipboard`,
      (err) => {
        if (err) console.error("Failed to copy:", err.message);
      },
    );
  }
}

// ── format for LLM tool ──────────────────────────────────────────────

function formatForTool(cache: TodoCache, entries: TimeEntry[]): string {
  const parts: string[] = [
    `### Active Issues (${cache.total_active})`,
    `Last synced: ${cache.last_synced}`,
    "",
  ];

  for (const issue of cache.issues) {
    parts.push(
      `- **#${issue.sequence_id}** ${issue.title}  ` +
        `State: ${issue.state_name} · Priority: ${issue.priority} · [open](${issue.link})`,
    );
  }

  const running = getRunningEntry(entries);
  if (running) {
    const elapsed = formatDuration(
      Date.now() - new Date(running.started_at).getTime(),
    );
    parts.push("");
    parts.push(
      `⏱ Currently tracking: #${running.sequence_id} ${running.title} (${elapsed})`,
    );
  }

  return parts.join("\n");
}

// ── extension state ──────────────────────────────────────────────────

let syncTimer: ReturnType<typeof setInterval> | null = null;
let overlayComponent: TodoOverlay | null = null;
let overlayHandle: { close: () => void } | null = null;

// Time entry state
let timeEntryState: TimeEntry[] = [];
let widgetTimerInterval: ReturnType<typeof setInterval> | null = null;
let lastCache: TodoCache | null = null;
let updateAvailableVersion: string | null = null;

function startWidgetTimer(
  ctx: { ui: { setWidget: (name: string, lines: string[]) => void } },
): void {
  if (widgetTimerInterval) return;
  widgetTimerInterval = setInterval(() => {
    if (!lastCache) return;
    const running = getRunningEntry(timeEntryState);
    const missing =
      running !== null &&
      !lastCache.issues.some((iss) => iss.id === running.issue_id);
    ctx.ui.setWidget(
      "todos",
      buildWidgetLines(lastCache, running, missing),
    );
  }, 1000);
}

function stopWidgetTimer(): void {
  if (widgetTimerInterval) {
    clearInterval(widgetTimerInterval);
    widgetTimerInterval = null;
  }
}

function handleToggleTime(
  ctx: { ui: { setWidget: (name: string, lines: string[]) => void }; cwd: string },
  issue: CachedIssue,
): void {
  const running = getRunningEntry(timeEntryState);
  if (running && running.issue_id === issue.id) {
    // Stop the running entry
    stopRunningEntry(timeEntryState, ctx.cwd);
    stopWidgetTimer();
  } else {
    // Stop existing if any, start new
    startTimeEntry(timeEntryState, issue, ctx.cwd);
    startWidgetTimer(ctx);
  }
  // Refresh widget
  if (lastCache) {
    const newRunning = getRunningEntry(timeEntryState);
    const missing =
      newRunning !== null &&
      !lastCache.issues.some((iss) => iss.id === newRunning.issue_id);
    ctx.ui.setWidget("todos", buildWidgetLines(lastCache, newRunning, missing));
  }
}

// ── extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── tool: get_todos ──────────────────────────────────────────────
  pi.registerTool({
    name: "get_todos",
    label: "Get Todos",
    description:
      "Retrieve the current list of active Plane.so todos for this project from local cache.",
    promptSnippet:
      "Retrieve the current list of active Plane.so todos for this project",
    promptGuidelines: [
      "Use get_todos when the user asks about their todo list, active issues, or what they need to work on.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const config = loadProjectConfig(ctx.cwd);
      if (!config) {
        return {
          content: [
            {
              type: "text",
              text: "No Plane project configured. Run `/todos` in an interactive session first to set up.",
            },
          ],
          details: {},
        };
      }

      const cache = loadCache(ctx.cwd);
      if (!cache) {
        return {
          content: [
            {
              type: "text",
              text: "No cached todos found. Run `/todos` first to fetch the issue list.",
            },
          ],
          details: {},
        };
      }

      return {
        content: [{ type: "text", text: formatForTool(cache, timeEntryState) }],
        details: { count: cache.total_active },
      };
    },
  });

  // ── command: /todos ──────────────────────────────────────────────
  pi.registerCommand("todos", {
    description: "List non-completed Plane.so todos for the current project",
    handler: async (_args: string, ctx) => {
      if (!ctx.hasUI) {
        // Fallback for non-interactive mode
        const setup = await ensureSetup(ctx);
        if (!setup) return;

        // Cache project identifier for future interactive use
        if (!setup.config.project_identifier) {
          const identifier = await fetchProjectIdentifier(
            setup.config,
            setup.token,
          );
          if (identifier) {
            setup.config.project_identifier = identifier;
            saveProjectConfig(ctx.cwd, setup.config);
          }
        }

        const { cache, error } = await buildCache(setup.config, setup.token);
        if (error) {
          console.error(error);
          return;
        }
        if (cache) {
          writeCache(ctx.cwd, cache);
          updateWidget(ctx, cache);
          console.log(formatForTool(cache, timeEntryState));
        }
        return;
      }

      // Interactive mode
      const setup = await ensureSetup(ctx);
      if (!setup) return;

      // Fetch project identifier if not already cached
      if (!setup.config.project_identifier) {
        const identifier = await fetchProjectIdentifier(
          setup.config,
          setup.token,
        );
        if (identifier) {
          setup.config.project_identifier = identifier;
          saveProjectConfig(ctx.cwd, setup.config);
        }
      }

      let cache = loadCache(ctx.cwd);

      if (!cache) {
        // First time — do a live fetch
        ctx.ui.notify("Fetching todos from Plane…", "info");
        const result = await buildCache(setup.config, setup.token);
        if (result.error) {
          ctx.ui.notify(result.error, "error");
          return;
        }
        if (!result.cache) {
          ctx.ui.notify("Failed to fetch todos.", "error");
          return;
        }
        cache = result.cache;
        writeCache(ctx.cwd, cache);
      }

      // Show widget
      updateWidget(ctx, cache);

      // Trigger background refresh first (fire-and-forget)
      triggerSync(ctx, setup);

      // Show overlay (blocks until user presses Esc)
      await showOverlay(
        ctx as never,
        cache,
        setup.config.project_identifier ?? null,
        ctx.cwd,
        (name, lines) => ctx.ui.setWidget(name, lines),
      );
    },
  });

  // ── startup: load cache, show widget, start sync ─────────────────
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const config = loadProjectConfig(ctx.cwd);
    const token = loadToken();
    if (!config || !token) return; // not set up yet

    // Fetch project identifier if not already cached
    if (!config.project_identifier) {
      const identifier = await fetchProjectIdentifier(config, token);
      if (identifier) {
        config.project_identifier = identifier;
        saveProjectConfig(ctx.cwd, config);
      }
    }

    // Load time entries
    timeEntryState = loadTimeEntries(ctx.cwd);

    const cache = loadCache(ctx.cwd);
    if (cache) {
      updateWidget(ctx, cache);
    }

    // Resume widget timer if a running entry exists
    if (getRunningEntry(timeEntryState)) {
      startWidgetTimer(ctx);
    }

    startSync(ctx, { token, config });

    // Check for extension updates (fire-and-forget, silent on failure)
    checkForUpdate().then(() => {
      if (updateAvailableVersion) {
        const current = getCurrentVersion();
        const repoUrl = getPackageRepoUrl();
        const installCmd = repoUrl
          ? `pi install ${repoUrl}@${updateAvailableVersion}`
          : `pi install git:github.com/WaldoJoubert-GH/pi-todos@${updateAvailableVersion}`;
        ctx.ui.notify(
          `pi-todos ${updateAvailableVersion} available (current: ${current}). Run: ${installCmd}`,
          "info",
        );
        // Refresh widget to show update pill
        const c = loadCache(ctx.cwd);
        if (c) updateWidget(ctx, c);
      }
    });
  });

  // ── cleanup ──────────────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    stopWidgetTimer();
    overlayComponent = null;
    overlayHandle = null;
  });
}

// ── sync management ──────────────────────────────────────────────────

function startSync(
  ctx: {
    ui: { setWidget: (name: string, lines: string[]) => void };
    cwd: string;
  },
  setup: { token: string; config: ProjectConfig },
): void {
  if (syncTimer) return;

  // Do an initial sync
  doSync(ctx, setup);

  syncTimer = setInterval(() => {
    doSync(ctx, setup);
  }, SYNC_INTERVAL_MS);
}

async function triggerSync(
  ctx: {
    ui: { setWidget: (name: string, lines: string[]) => void };
    cwd: string;
  },
  setup: { token: string; config: ProjectConfig },
): Promise<void> {
  await doSync(ctx, setup);
}

let syncing = false;

async function doSync(
  ctx: {
    ui: { setWidget: (name: string, lines: string[]) => void };
    cwd: string;
  },
  setup: { token: string; config: ProjectConfig },
): Promise<void> {
  if (syncing) return;
  syncing = true;

  try {
    const { cache, error } = await buildCache(setup.config, setup.token);

    if (error) {
      // Keep stale cache, mark error
      const existing = loadCache(ctx.cwd);
      if (existing) {
        existing.sync_error = true;
        writeCache(ctx.cwd, existing);
        updateWidget(ctx, existing);
      }
      return;
    }

    if (cache) {
      cache.sync_error = false;
      writeCache(ctx.cwd, cache);
      updateWidget(ctx, cache);

      // Note: overlay is not updated live. User closes and re-opens /todos to see fresh data.
    }
  } finally {
    syncing = false;
  }
}

// ── widget update ────────────────────────────────────────────────────

function updateWidget(
  ctx: { ui: { setWidget: (name: string, lines: string[]) => void } },
  cache: TodoCache,
): void {
  lastCache = cache;
  const running = getRunningEntry(timeEntryState);
  const missing =
    running !== null &&
    !cache.issues.some((iss) => iss.id === running.issue_id);
  ctx.ui.setWidget("todos", buildWidgetLines(cache, running, missing));
}

// ── overlay display ──────────────────────────────────────────────────

async function showOverlay(
  ctx: never,
  cache: TodoCache,
  projectIdentifier: string | null,
  cwd: string,
  setWidget: (name: string, lines: string[]) => void,
): Promise<void> {
  // ctx.ui.custom can work in two modes:
  //   1. ctx.ui.custom(component)              -> handle (non-overlay)
  //   2. ctx.ui.custom(factory, { overlay })   -> Promise (overlay)
  // We use mode 2 here.
  const ui = ctx as unknown as {
    ui: {
      custom: (
        factory: (...args: unknown[]) => unknown,
        opts: {
          overlay: boolean;
          onHandle?: (h: { close: () => void }) => void;
        },
      ) => Promise<null>;
    };
  };

  await ui.ui.custom(
    (
      _tui: unknown,
      theme: {
        fg: (color: string, text: string) => string;
        bg: (color: string, text: string) => string;
      },
      _keybindings: unknown,
      done: (result: null) => void,
    ) => {
      const component = new TodoOverlay(
        cache.issues,
        theme,
        () => done(null),
        projectIdentifier,
        (issue: CachedIssue) => {
          handleToggleTime({ ui: { setWidget }, cwd }, issue);
        },
        () => getRunningEntry(timeEntryState)?.issue_id ?? null,
        (issueId: string) => getAccumulatedMs(timeEntryState, issueId),
        (issueId: string) =>
          timeEntryState.filter((e) => e.issue_id === issueId),
      );
      overlayComponent = component;
      return component;
    },
    {
      overlay: true,
      onHandle: (handle: { close: () => void }) => {
        overlayHandle = handle;
      },
    },
  );

  // Cleanup when overlay closes
  overlayComponent = null;
  overlayHandle = null;
}
