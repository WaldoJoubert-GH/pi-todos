import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as cp from "node:child_process";
import { Type } from "typebox";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── constants ────────────────────────────────────────────────────────

const PLANE_API_BASE = "https://api.plane.so/api/v1";
const SECRETS_FILE = path.join(os.homedir(), ".pi", "agent", "secrets", "plane.json");
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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

// ── types ────────────────────────────────────────────────────────────

interface CachedIssue {
  id: string;
  sequence_id: number;
  title: string;
  description: string;
  state_name: string;
  state_group: string;
  state_hex: string;
  assignee: string;
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

interface RawMember {
  member: string; // UUID
  member__display_name?: string;
  display_name?: string;
}

// ── token helpers ────────────────────────────────────────────────────

function loadToken(): string | null {
  try {
    const raw = fs.readFileSync(SECRETS_FILE, "utf-8");
    const data = JSON.parse(raw);
    return typeof data.token === "string" && data.token.length > 0 ? data.token : null;
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
    const raw = fs.readFileSync(path.join(cwd, ".todo", "config.json"), "utf-8");
    const data: Record<string, unknown> = JSON.parse(raw);
    if (typeof data.workspace_slug !== "string" || typeof data.project_id !== "string") {
      return null;
    }
    return {
      workspace_slug: data.workspace_slug,
      project_id: data.project_id,
      project_identifier: typeof data.project_identifier === "string" ? data.project_identifier : undefined,
    };
  } catch {
    return null;
  }
}

function saveProjectConfig(cwd: string, cfg: ProjectConfig): void {
  const dir = path.join(cwd, ".todo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2), "utf-8");
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
    map.set(s.id, { name: s.name, group: s.group, color: s.color || "#808080" });
  }
  return map;
}

async function fetchMemberMap(
  config: ProjectConfig,
  token: string,
): Promise<Map<string, string>> {
  const url = `${PLANE_API_BASE}/workspaces/${config.workspace_slug}/projects/${config.project_id}/members/`;
  const result = await apiFetch<{ results?: RawMember[] }>(url, token);
  if (!result.ok) return new Map();

  const map = new Map<string, string>();
  for (const m of result.data.results ?? []) {
    const name = m.member__display_name ?? m.display_name ?? m.member ?? "unknown";
    map.set(m.member, name);
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
    const input = await ctx.ui.input("Enter your Plane.so Personal Access Token:");
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
  const [issuesResult, stateMap, memberMap] = await Promise.all([
    apiFetch<{ results?: RawIssue[] }>(issuesUrl, token),
    fetchStateMap(config, token),
    fetchMemberMap(config, token),
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

  const statesAcc: Record<string, { count: number; color: string; group: string }> = {};

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

    const assignee =
      issue.assignees
        .map((uid) => memberMap.get(uid))
        .filter(Boolean)
        .join(", ") || "unassigned";

    const link = `https://app.plane.so/${config.workspace_slug}/projects/${config.project_id}/issues/${issue.id}`;

    const description =
      issue.description_stripped ?? stripHtml(issue.description_html ?? "") ?? "";

    return {
      id: issue.id,
      sequence_id: issue.sequence_id,
      title: issue.name,
      description,
      state_name: stateName,
      state_group: group,
      state_hex: stateHex,
      assignee,
      link,
    };
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

function buildWidgetLines(cache: TodoCache): string[] {
  const syncIcon = cache.sync_error ? "⚠️ " : "";
  const lines: string[] = [`${syncIcon}✈️ Todos: ${cache.total_active} active`];

  const pillParts: string[] = [];

  if (cache.states) {
    // New format: per-state pills ordered by group, then alpha
    const entries = Object.entries(cache.states).sort(([nameA, a], [nameB, b]) => {
      const gOrderA = GROUP_ORDER.indexOf(a.group);
      const gOrderB = GROUP_ORDER.indexOf(b.group);
      if (gOrderA !== gOrderB) {
        return (gOrderA === -1 ? 999 : gOrderA) - (gOrderB === -1 ? 999 : gOrderB);
      }
      return nameA.localeCompare(nameB);
    });

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

  return lines;
}

// ── strip HTML ─────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ").trim();
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

  constructor(
    issues: CachedIssue[],
    theme: {
      fg: (color: string, text: string) => string;
      bg: (color: string, text: string) => string;
    },
    onClose: () => void,
    projectIdentifier: string | null,
  ) {
    this.issues = issues;
    this.theme = theme;
    this.onClose = onClose;
    this.projectIdentifier = projectIdentifier;
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
      if (issue && this.projectIdentifier) {
        const id = `${this.projectIdentifier}-${issue.sequence_id}`;
        copyToClipboard(id);
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
    const title = `✈️ Todos (${this.issues.length} active)`;
    const topDash = Math.max(0, innerW - title.length - 3);
    lines.push(B("┌─ ") + t.fg("accent", title) + B(" " + "─".repeat(topDash) + "┐"));

    // ── header row ───────────────────────────────────────────────────
    const seqW = 6;
    const stateW = 12;
    const assigneeW = 16;
    const gapW = 6; // 3 gaps × 2 spaces
    const headerTitleW = innerW - seqW - stateW - assigneeW - gapW;
    const rowTitleW = headerTitleW - 1; // rows have " " or ">" prefix that steals 1 char

    if (headerTitleW < 10) {
      // Terminal too narrow — minimal view with border
      const narrowTitle = padOrTrunc("Terminal too narrow", innerW);
      lines.push(B("│") + t.fg("muted", narrowTitle) + B("│"));
      const showIssues = this.issues.slice(0, Math.min(10, this.issues.length));
      for (const iss of showIssues) {
        const row = padOrTrunc(`#${iss.sequence_id} ${iss.title}`, innerW);
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

    const header = padOrTrunc("ID", seqW) + "  " +
      padOrTrunc("Title", headerTitleW) + "  " +
      padOrTrunc("State", stateW) + "  " +
      padOrTrunc("Assignee", assigneeW);
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

      const seqStr = padOrTrunc(`#${issue.sequence_id}`, seqW);
      const titleStr = padOrTrunc(issue.title, rowTitleW);
      const stateStr = padOrTrunc(issue.state_name, stateW);
      const assigneeStr = padOrTrunc(issue.assignee, assigneeW);

      // Color the state text using Plane's per-state hex
      const coloredState = hexToAnsi(issue.state_hex, stateStr);

      const row = `${seqStr}  ${titleStr}  ${coloredState}  ${assigneeStr}`;
      // ANSI codes in coloredState inflate str.length; use visibleWidth for padding
      const rowVis = visibleWidth(`>${row}`);

      if (isSelected) {
        const selectedContent = t.bg("selectedBg", t.fg("text", `>${row}`));
        // Pad to innerW so selectedBg fills to the right border
        const padLen = Math.max(0, innerW - rowVis);
        lines.push(B("│") + selectedContent + " ".repeat(padLen) + B("│"));
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
    const footer = padOrTrunc("↑↓ scroll  Enter preview  Ctrl+Enter open  c copy ID  Esc close", innerW);
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
    const title = `✈️ Issue #${issue.sequence_id}`;
    const topDash = Math.max(0, innerW - title.length - 3);
    lines.push(B("┌─ ") + t.bg("selectedBg", t.fg("text", title)) + B(" " + "─".repeat(topDash) + "┐"));

    // ── issue title (wrapped) ────────────────────────────────────────
    const titleLines = wrapText(`Title: ${issue.title}`, innerW);
    for (const tl of titleLines) {
      const tlPad = Math.max(0, innerW - visibleWidth(tl));
      lines.push(B("│") + t.fg("accent", tl) + " ".repeat(tlPad) + B("│"));
    }

    // ── meta info ────────────────────────────────────────────────────
    const coloredState = hexToAnsi(issue.state_hex, issue.state_name);
    const meta = `${coloredState}  ${t.fg("muted", "· Assignee: " + issue.assignee)}`;
    const metaPad = Math.max(0, innerW - visibleWidth(meta));
    lines.push(B("│") + meta + " ".repeat(metaPad) + B("│"));

    // ── separator ────────────────────────────────────────────────────
    lines.push(B("├" + "─".repeat(innerW) + "┤"));

    // ── description header ───────────────────────────────────────────
    const descHdr = padOrTrunc("Description:", innerW);
    lines.push(B("│") + t.fg("dim", descHdr) + B("│"));
    // empty line
    lines.push(B("│" + " ".repeat(innerW) + "│"));

    // ── description text (wrapped) ───────────────────────────────────
    const desc = issue.description || "(no description)";
    const descLines = wrapText(desc, innerW);

    // Calculate available description height
    const viewH = this.visibleHeight || Math.min(25, Math.max(5, Math.floor(width * 0.5)));
    // Chrome rows: top border + title lines + meta + separator + desc header + empty + sep + footer + bottom border
    const chromeRows = 1 + titleLines.length + 1 + 1 + 1 + 1 + 1 + 1 + 1;
    const availDescH = Math.max(3, viewH - chromeRows);

    // Clamp detailScroll
    const maxScroll = Math.max(0, descLines.length - availDescH);
    this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll));

    const endIdx = Math.min(this.detailScroll + availDescH, descLines.length);
    for (let i = this.detailScroll; i < endIdx; i++) {
      const dcPad = Math.max(0, innerW - visibleWidth(descLines[i]));
      lines.push(B("│") + descLines[i] + " ".repeat(dcPad) + B("│"));
    }

    if (endIdx < descLines.length) {
      const indicator = `↓ ${descLines.length - endIdx} more lines`;
      const indPad = Math.max(0, innerW - indicator.length);
      lines.push(B("│") + t.fg("muted", indicator) + " ".repeat(indPad) + B("│"));
    }

    // ── separator ────────────────────────────────────────────────────
    lines.push(B("├" + "─".repeat(innerW) + "┤"));

    // ── footer ───────────────────────────────────────────────────────
    const footer = padOrTrunc("Esc back  ↑↓ scroll  Ctrl+Enter open in browser  c copy ID", innerW);
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
    cp.exec(`echo -n '${escaped}' | wl-copy 2>/dev/null || echo -n '${escaped}' | xclip -selection clipboard`, (err) => {
      if (err) console.error("Failed to copy:", err.message);
    });
  }
}

// ── format for LLM tool ──────────────────────────────────────────────

function formatForTool(cache: TodoCache): string {
  const parts: string[] = [
    `### Active Issues (${cache.total_active})`,
    `Last synced: ${cache.last_synced}`,
    "",
  ];

  for (const issue of cache.issues) {
    parts.push(
      `- **#${issue.sequence_id}** ${issue.title}  ` +
        `State: ${issue.state_name} · ${issue.assignee} · [open](${issue.link})`,
    );
  }

  return parts.join("\n");
}

// ── extension state ──────────────────────────────────────────────────

let syncTimer: ReturnType<typeof setInterval> | null = null;
let overlayComponent: TodoOverlay | null = null;
let overlayHandle: { close: () => void } | null = null;

// ── extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── tool: get_todos ──────────────────────────────────────────────
  pi.registerTool({
    name: "get_todos",
    label: "Get Todos",
    description: "Retrieve the current list of active Plane.so todos for this project from local cache.",
    promptSnippet: "Retrieve the current list of active Plane.so todos for this project",
    promptGuidelines: [
      "Use get_todos when the user asks about their todo list, active issues, or what they need to work on.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const config = loadProjectConfig(ctx.cwd);
      if (!config) {
        return {
          content: [{ type: "text", text: "No Plane project configured. Run `/todos` in an interactive session first to set up." }],
          details: {},
        };
      }

      const cache = loadCache(ctx.cwd);
      if (!cache) {
        return {
          content: [{ type: "text", text: "No cached todos found. Run `/todos` first to fetch the issue list." }],
          details: {},
        };
      }

      return {
        content: [{ type: "text", text: formatForTool(cache) }],
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
          const identifier = await fetchProjectIdentifier(setup.config, setup.token);
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
          console.log(formatForTool(cache));
        }
        return;
      }

      // Interactive mode
      const setup = await ensureSetup(ctx);
      if (!setup) return;

      // Fetch project identifier if not already cached
      if (!setup.config.project_identifier) {
        const identifier = await fetchProjectIdentifier(setup.config, setup.token);
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
      await showOverlay(ctx as never, cache, setup.config.project_identifier ?? null);
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

    const cache = loadCache(ctx.cwd);
    if (cache) {
      updateWidget(ctx, cache);
    }

    startSync(ctx, { token, config });
  });

  // ── cleanup ──────────────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    overlayComponent = null;
    overlayHandle = null;
  });
}

// ── sync management ──────────────────────────────────────────────────

function startSync(
  ctx: { ui: { setWidget: (name: string, lines: string[]) => void }; cwd: string },
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
  ctx: { ui: { setWidget: (name: string, lines: string[]) => void }; cwd: string },
  setup: { token: string; config: ProjectConfig },
): Promise<void> {
  await doSync(ctx, setup);
}

let syncing = false;

async function doSync(
  ctx: { ui: { setWidget: (name: string, lines: string[]) => void }; cwd: string },
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
  ctx.ui.setWidget("todos", buildWidgetLines(cache));
}

// ── overlay display ──────────────────────────────────────────────────

async function showOverlay(
  ctx: never,
  cache: TodoCache,
  projectIdentifier: string | null,
): Promise<void> {
  // ctx.ui.custom can work in two modes:
  //   1. ctx.ui.custom(component)              -> handle (non-overlay)
  //   2. ctx.ui.custom(factory, { overlay })   -> Promise (overlay)
  // We use mode 2 here.
  const ui = ctx as unknown as {
    ui: {
      custom: (factory: (...args: unknown[]) => unknown, opts: { overlay: boolean; onHandle?: (h: { close: () => void }) => void }) => Promise<null>;
    };
  };

  await ui.ui.custom(
    (_tui: unknown, theme: {
      fg: (color: string, text: string) => string;
      bg: (color: string, text: string) => string;
    }, _keybindings: unknown, done: (result: null) => void) => {
      const component = new TodoOverlay(cache.issues, theme, () => done(null), projectIdentifier);
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
