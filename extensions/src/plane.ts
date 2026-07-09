import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as cp from "node:child_process";
import type {
  UnifiedIssue,
  RawPlaneIssue,
  RawPlaneState,
  PlaneCache,
  PlaneConfig,
  TimeEntry,
  PlaneStateItem,
} from "./types.js";
import {
  loadPlaneToken,
  savePlaneToken,
  ensureDevDir,
  devDir,
  replacePlaneIssues,
  loadTimeEntries,
  saveTimeEntries,
  loadDevConfig,
  updatePlaneConfig,
  loadPlaneStates,
  savePlaneStates,
} from "./config.js";

// ── constants ────────────────────────────────────────────────────────

const PLANE_API_BASE = "https://api.plane.so/api/v1";
const SECRETS_FILE = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "secrets",
  "plane.json",
);
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const CURRENT_VERSION_FALLBACK = "1.0.1";
const VERSION_CHECK_TIMEOUT_MS = 5000;

const EXCLUDED_GROUPS = new Set(["completed", "cancelled"]);
export const GROUP_ORDER = [
  "backlog",
  "unstarted",
  "started",
  "triage",
  "cancelled",
];

// ── priority maps ────────────────────────────────────────────────────

export const PRIORITY_COLORS: Record<string, string> = {
  urgent: "#EF4444",
  high: "#F59E0B",
  medium: "#EAB308",
  low: "#3B82F6",
  none: "#9CA3AF",
};

export const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

// ── ANSI helpers ─────────────────────────────────────────────────────

export function hexToAnsi(hex: string, text: string): string {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return text;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Render a State as a background-filled pill with auto-contrast text. */
export function statePill(hex: string, text: string): string {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return text;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return text;
  const padded = ` ${text} `;
  const fgR = relativeLuminance(r, g, b) > 0.5 ? 0 : 255;
  const fgG = fgR;
  const fgB = fgR;
  return `\x1b[38;2;${fgR};${fgG};${fgB};48;2;${r};${g};${b}m${padded}\x1b[0m`;
}

export function priorityLabel(priority: string): string {
  const label = priority || "none";
  const hex = PRIORITY_COLORS[label] ?? PRIORITY_COLORS.none;
  return hexToAnsi(hex, label);
}

// ── duration ─────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
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

export function formatDurationHm(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

// ── version check ────────────────────────────────────────────────────

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

export async function checkForUpdate(): Promise<string | null> {
  try {
    const currentVersion = getCurrentVersion();
    const repoUrl = getPackageRepoUrl();
    if (!repoUrl) return null;

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

    return latestVersion !== currentVersion ? latestVersion : null;
  } catch {
    return null;
  }
}

export function getCurrentVersionPublic(): string {
  return getCurrentVersion();
}

export function getPackageRepoUrlPublic(): string | null {
  return getPackageRepoUrl();
}

// ── API fetch ────────────────────────────────────────────────────────

type ApiOk<T> = { ok: true; status: number; data: T };
type ApiErr = { ok: false; status: number; body: string };
type ApiResult<T> = ApiOk<T> | ApiErr;

async function apiFetch<T>(
  url: string,
  token: string,
  method: string = "GET",
  body?: unknown,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    const headers: Record<string, string> = { "X-Api-Key": token };
    if (body) headers["Content-Type"] = "application/json";
    const options: RequestInit = { method, headers };
    if (body) options.body = JSON.stringify(body);
    response = await fetch(url, options);
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
    return {
      ok: false,
      status: response.status,
      body: "Failed to parse JSON",
    };
  }
  return { ok: true, status: response.status, data };
}

// ── config helpers (interactive setup) ───────────────────────────────

export async function ensurePlaneSetup(ctx: {
  hasUI: boolean;
  ui: {
    input(p: string): Promise<string | undefined>;
    notify(m: string, t?: string): void;
  };
  cwd: string;
}): Promise<{ token: string; config: PlaneConfig } | null> {
  if (!ctx.hasUI) {
    console.log(
      "=== /issues ===\n" +
        "To use this command interactively, run pi without --print/-p.\n\n" +
        "Manual setup:\n" +
        `  1. Save your Plane PAT to ${SECRETS_FILE}:\n` +
        '     { "token": "pt_..." }\n' +
        "  2. Create .dev/config.json in the project root:\n" +
        '     { "plane": { "workspace_slug": "...", "project_id": "..." } }\n',
    );
    return null;
  }

  let token = loadPlaneToken();
  if (!token) {
    const input = await ctx.ui.input(
      "Enter your Plane.so Personal Access Token:",
    );
    if (!input || input.trim().length === 0) {
      ctx.ui.notify("No token provided — aborting.", "error");
      return null;
    }
    token = input.trim();
    savePlaneToken(token);
    ctx.ui.notify(
      "Token saved to ~/.pi/agent/secrets/plane.json",
      "info",
    );
  }

  let config = loadDevConfig(ctx.cwd).plane;
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
    updatePlaneConfig(ctx.cwd, config);
    ctx.ui.notify("Config saved to .dev/config.json", "info");
  }

  return { token, config };
}

// ── fetch project identifier ─────────────────────────────────────────

export async function fetchProjectIdentifier(
  config: PlaneConfig,
  token: string,
): Promise<string | null> {
  const url = `${PLANE_API_BASE}/workspaces/${config.workspace_slug}/projects/${config.project_id}/`;
  const result = await apiFetch<{ identifier?: string }>(url, token);
  if (!result.ok) return null;
  return result.data.identifier ?? null;
}

// ── fetch state map ──────────────────────────────────────────────────

async function fetchStateMap(
  config: PlaneConfig,
  token: string,
): Promise<Map<string, { name: string; group: string; color: string }>> {
  const url = `${PLANE_API_BASE}/workspaces/${config.workspace_slug}/projects/${config.project_id}/states/`;
  const result = await apiFetch<{ results?: RawPlaneState[] }>(url, token);
  if (!result.ok) return new Map();

  const map = new Map<
    string,
    { name: string; group: string; color: string }
  >();
  for (const s of result.data.results ?? []) {
    map.set(s.id, {
      name: s.name,
      group: s.group,
      color: s.color || "#808080",
    });
  }
  return map;
}

// ── strip HTML ───────────────────────────────────────────────────────

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

// ── build plane cache (fetches from API) ─────────────────────────────

export async function buildPlaneCache(
  config: PlaneConfig,
  token: string,
): Promise<{ cache: PlaneCache | null; error: string | null; stateItems: PlaneStateItem[] }> {
  const issuesUrl = `${PLANE_API_BASE}/workspaces/${config.workspace_slug}/projects/${config.project_id}/issues/?per_page=1000`;
  const [issuesResult, stateMap] = await Promise.all([
    apiFetch<{ results?: RawPlaneIssue[] }>(issuesUrl, token),
    fetchStateMap(config, token),
  ]);

  if (!issuesResult.ok) {
    return {
      cache: null,
      error: `Plane API error: ${issuesResult.status} ${issuesResult.body}`,
      stateItems: [],
    };
  }

  const all = issuesResult.data.results ?? [];
  const active = all.filter((issue) => {
    const stateObj = issue.state ? stateMap.get(issue.state) : undefined;
    if (!stateObj) return true;
    return !EXCLUDED_GROUPS.has(stateObj.group);
  });

  const statesAcc: Record<
    string,
    { count: number; color: string; group: string }
  > = {};

  const now = new Date().toISOString();
  const issues: UnifiedIssue[] = active.map((issue) => {
    const stateObj = issue.state ? stateMap.get(issue.state) : undefined;
    const group = stateObj?.group ?? "unknown";
    const stateName = stateObj?.name ?? "Unknown";
    const stateHex = stateObj?.color ?? "#808080";

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
      source: "plane",
      id: issue.id,
      sequence_id: issue.sequence_id,
      title: issue.name,
      description,
      state_id: issue.state,
      state_name: stateName,
      state_group: group,
      state_hex: stateHex,
      priority,
      link,
      updated_at: now,
    };
  });

  // Sort: priority → state group → title
  const GROUP_SORT: Record<string, number> = {
    backlog: 0,
    unstarted: 1,
    started: 2,
    triage: 3,
    cancelled: 4,
  };
  issues.sort((a, b) => {
    const pA = PRIORITY_ORDER[a.priority ?? "none"] ?? 99;
    const pB = PRIORITY_ORDER[b.priority ?? "none"] ?? 99;
    if (pA !== pB) return pA - pB;
    const gA = GROUP_SORT[a.state_group ?? "unknown"] ?? 99;
    const gB = GROUP_SORT[b.state_group ?? "unknown"] ?? 99;
    if (gA !== gB) return gA - gB;
    return a.title.localeCompare(b.title);
  });

  const cache: PlaneCache = {
    last_synced: now,
    workspace_slug: config.workspace_slug,
    project_id: config.project_id,
    issues,
    states: statesAcc,
    total_active: issues.length,
  };

  // Build state items from the fetched state map
  const stateItems: PlaneStateItem[] = [];
  for (const [id, s] of stateMap) {
    stateItems.push({ id, name: s.name, color: s.color, group: s.group });
  }

  return { cache, error: null, stateItems };
}

// ── states cache ────────────────────────────────────────────────────

export function loadStatesCache(cwd: string): PlaneStateItem[] {
  const cached = loadPlaneStates(cwd);
  return cached?.states ?? [];
}

export function saveStatesCache(
  cwd: string,
  states: PlaneStateItem[],
): void {
  savePlaneStates(cwd, {
    last_fetched: new Date().toISOString(),
    states,
  });
}

function buildStateItems(stateMap: Map<string, RawPlaneState>): PlaneStateItem[] {
  const items: PlaneStateItem[] = [];
  for (const [id, s] of stateMap) {
    items.push({
      id,
      name: s.name,
      color: s.color || "#808080",
      group: s.group,
    });
  }
  return items;
}

/** Fetch states from the Plane API, bypassing cache. */
async function fetchStates(
  config: PlaneConfig,
  token: string,
): Promise<Map<string, RawPlaneState>> {
  const url = `${PLANE_API_BASE}/workspaces/${config.workspace_slug}/projects/${config.project_id}/states/`;
  const result = await apiFetch<{ results?: RawPlaneState[] }>(url, token);
  if (!result.ok) return new Map();

  const map = new Map<string, RawPlaneState>();
  for (const s of result.data.results ?? []) {
    map.set(s.id, s);
  }
  return map;
}

/**
 * Get the workspace States list. Reads from cache if available,
 * force-fetches from the API if the cache is cold.
 */
export async function getStates(
  cwd: string,
  config: PlaneConfig,
  token: string,
): Promise<PlaneStateItem[]> {
  const cached = loadPlaneStates(cwd);
  if (cached && cached.states.length > 0) return cached.states;

  const map = await fetchStates(config, token);
  const items = buildStateItems(map);
  saveStatesCache(cwd, items);
  return items;
}

// ── patch issue state ───────────────────────────────────────────────

export async function patchIssueState(
  config: PlaneConfig,
  token: string,
  issueId: string,
  stateId: string,
): Promise<boolean> {
  const url = `${PLANE_API_BASE}/workspaces/${config.workspace_slug}/projects/${config.project_id}/issues/${issueId}/`;
  const result = await apiFetch<unknown>(url, token, "PATCH", { state: stateId });
  return result.ok;
}

// ── sync (fetch + persist) ───────────────────────────────────────────

export async function syncPlane(
  cwd: string,
  config: PlaneConfig,
  token: string,
): Promise<PlaneCache | null> {
  const { cache, error, stateItems } = await buildPlaneCache(config, token);

  if (error || !cache) {
    // Mark sync error on existing issues file
    const existing = loadDevConfig(cwd);
    if (existing.plane) {
      // Don't touch the issues file, just return null
    }
    return null;
  }

  cache.sync_error = false;
  replacePlaneIssues(cwd, cache.issues, cache.last_synced);
  saveStatesCache(cwd, stateItems);
  return cache;
}

// ── time entry management ────────────────────────────────────────────

export function getRunningEntry(entries: TimeEntry[]): TimeEntry | null {
  return entries.find((e) => e.stopped_at === null) ?? null;
}

export function getAccumulatedMs(
  entries: TimeEntry[],
  issueId: string,
): number {
  let total = 0;
  for (const e of entries) {
    if (e.issue_id !== issueId) continue;
    const start = new Date(e.started_at).getTime();
    const end = e.stopped_at
      ? new Date(e.stopped_at).getTime()
      : Date.now();
    total += end - start;
  }
  return total;
}

export function startTimeEntry(
  entries: TimeEntry[],
  issue: UnifiedIssue,
  cwd: string,
): void {
  const now = new Date().toISOString();
  for (const e of entries) {
    if (e.stopped_at === null) {
      e.stopped_at = now;
    }
  }
  entries.push({
    issue_id: issue.id!,
    sequence_id: issue.sequence_id!,
    title: issue.title,
    started_at: now,
    stopped_at: null,
  });
  saveTimeEntries(cwd, entries);
}

export function stopRunningEntry(
  entries: TimeEntry[],
  cwd: string,
): void {
  const now = new Date().toISOString();
  for (const e of entries) {
    if (e.stopped_at === null) {
      e.stopped_at = now;
    }
  }
  saveTimeEntries(cwd, entries);
}

// ── format for LLM tool ──────────────────────────────────────────────

export function formatPlaneForTool(cache: PlaneCache): string {
  const parts: string[] = [
    `### Plane Issues (${cache.total_active})`,
    `Last synced: ${cache.last_synced}`,
    "",
  ];

  for (const issue of cache.issues) {
    parts.push(
      `- **#${issue.sequence_id}** ${issue.title}  ` +
        `State: ${issue.state_name} · Priority: ${issue.priority} · [open](${issue.link})`,
    );
  }

  return parts.join("\n");
}
