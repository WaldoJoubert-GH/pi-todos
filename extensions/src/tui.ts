import type {
  UnifiedIssue,
  IssueSource,
  PlaneCache,
  TimeEntry,
  AutotaskTimeRecord,
  AutotaskCache,
  PlaneStateItem,
  GitHubWidgetStatus,
  GitHubRun,
  GitHubJob,
} from "./types.js";
import type { DashboardRow } from "./autotask.js";
import {
  hexToAnsi,
  statePill,
  priorityLabel,
  formatDuration,
  formatDurationHm,
  formatTimestamp,
  GROUP_ORDER,
  ACTIVE_GROUPS,
} from "./plane.js";
import {
  GH_ICONS,
  GH_COLORS,
  GH_LABELS,
  formatRelativeTime,
  formatElapsed,
} from "./github.js";
import {
  decodeKittyPrintable,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── filter type ──────────────────────────────────────────────────────

export type IssueFilter = "all" | "plane" | "sentry";

export type StateGroupFilter = "all" | "backlog" | "unstarted" | "started" | "triage" | "completed" | "cancelled";

const FILTER_CYCLE: IssueFilter[] = ["all", "plane", "sentry"];
const FILTER_LABELS: Record<IssueFilter, string> = {
  all: "All",
  plane: "\uF273 Plane",
  sentry: "\uF188 Sentry",
};

const STATE_GROUP_CYCLE: StateGroupFilter[] = [
  "all",
  "backlog",
  "unstarted",
  "started",
  "triage",
  "completed",
  "cancelled",
];
const STATE_GROUP_LABELS: Record<StateGroupFilter, string> = {
  all: "All",
  backlog: "Backlog",
  unstarted: "Unstarted",
  started: "Started",
  triage: "Triage",
  completed: "Completed",
  cancelled: "Cancelled",
};

// ── sentry level colors ──────────────────────────────────────────────

const SENTRY_LEVEL_COLORS: Record<string, string> = {
  fatal: "#EF4444",
  error: "#EF4444",
  warning: "#F59E0B",
  info: "#3B82F6",
  debug: "#9CA3AF",
};

function sentryLevelLabel(level: string): string {
  const hex = SENTRY_LEVEL_COLORS[level] ?? SENTRY_LEVEL_COLORS.error;
  return hexToAnsi(hex, level);
}

// ── helpers ──────────────────────────────────────────────────────────

function padOrTrunc(str: string, len: number): string {
  // truncateToWidth injects \x1b[0m even for plain text; strip it to
  // avoid breaking parent ANSI styling (e.g. t.bg selectedBg).
  return truncateToWidth(str, len, "\u2026", true).replace(/\x1b\[0m/g, "");
}

function wrapText(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, width);
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
    cp.exec(
      `echo -n '${escaped}' | wl-copy 2>/dev/null || echo -n '${escaped}' | xclip -selection clipboard`,
      (err) => {
        if (err) console.error("Failed to copy:", err.message);
      },
    );
  }
}

// ── widget builder ───────────────────────────────────────────────────

export function abbreviateState(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

export function buildWidgetLines(
  planeCache: PlaneCache | null,
  sentryCount: number,
  runningEntry: TimeEntry | null,
  missingIssue: boolean,
  dailyTotalMs: number,
  projectIdentifier: string | null = null,
  ghStatus: GitHubWidgetStatus | null = null,
): string[] {
  const lines: string[] = [];

  // Line 1: counts line with daily total
  const parts: string[] = [];
  if (planeCache && planeCache.total_active > 0) {
    const planeIcon = planeCache.sync_error ? "\uF06A " : "\uF273 ";
    parts.push(
      `${planeIcon}${planeCache.total_active} todos`,
    );
  }
  if (sentryCount > 0) {
    parts.push(`\uF188 ${sentryCount} sentry`);
  }
  // Daily total always visible
  parts.push(`\uF017 ${formatDurationHm(dailyTotalMs)}`);
  // GitHub Actions segment (appended last on line 1)
  if (ghStatus) {
    parts.push(formatGhWidgetSegment(ghStatus));
  }
  if (parts.length === 1 && planeCache === null) {
    // Only the daily total, no issues — prefix with zero-state
    lines.push(`\uF05E all clear  ${parts[0]}`);
  } else {
    // Determine if we should show "all clear" — when there are no issues from any source
    const hasIssues =
      (planeCache && planeCache.total_active > 0) || sentryCount > 0;
    if (!hasIssues && planeCache === null) {
      // Reconstruct line 1 with all-clear prefix
      lines.push(`\uF05E all clear  ${parts.join("  ")}`);
    } else {
      lines.push(parts.join("  "));
    }
  }

  // Line 2+: Plane state pills (if plane configured)
  if (planeCache && planeCache.states) {
    const entries = Object.entries(planeCache.states).sort(
      ([nameA, a], [nameB, b]) => {
        const gOrderA = GROUP_ORDER.indexOf(a.group);
        const gOrderB = GROUP_ORDER.indexOf(b.group);
        if (gOrderA !== gOrderB) {
          return (
            (gOrderA === -1 ? 999 : gOrderA) -
            (gOrderB === -1 ? 999 : gOrderB)
          );
        }
        return nameA.localeCompare(nameB);
      },
    );

    const pillParts: string[] = [];
    for (const [name, { count, color, group }] of entries) {
      if (count === 0) continue;
      // Widget stays active-only — skip completed/cancelled
      if (group === "completed" || group === "cancelled") continue;
      pillParts.push(
        statePill(color, `${abbreviateState(name)}: ${count}`),
      );
    }
    if (pillParts.length > 0) {
      lines.push(pillParts.join("  "));
    }
  }

  // In-progress issue titles (state name is "In Progress")
  if (planeCache && planeCache.issues) {
    const startedIssues = planeCache.issues.filter(
      (i) => i.state_name === "In Progress",
    );
    const MAX_INPROGRESS_SHOWN = 5;
    const shown = startedIssues.slice(0, MAX_INPROGRESS_SHOWN);
    for (const iss of shown) {
      const slug =
        projectIdentifier && iss.sequence_id != null
          ? `${projectIdentifier}-${iss.sequence_id}`
          : iss.sequence_id != null
            ? `#${iss.sequence_id}`
            : "#?";
      const color = iss.state_hex ?? "#808080";
      const coloredSlug = hexToAnsi(color, slug);
      const title =
        iss.title.length > 75
          ? iss.title.slice(0, 74) + "\u2026"
          : iss.title;
      lines.push(
        `\uF0A9 ${coloredSlug} ${title}`,
      );
    }
    const remaining = startedIssues.length - MAX_INPROGRESS_SHOWN;
    if (remaining > 0) {
      lines.push(`  \u2026 and ${remaining} more`);
    }
  }

  // Running entry line
  if (runningEntry) {
    const prefix = missingIssue ? "\uF06A " : "\uF252 ";
    const title =
      runningEntry.title.length > 30
        ? runningEntry.title.slice(0, 29) + "\u2026"
        : runningEntry.title;
    const elapsed = formatDuration(
      Date.now() - new Date(runningEntry.started_at).getTime(),
    );
    lines.push(
      `${prefix}#${runningEntry.sequence_id} ${title} \u2014 ${elapsed}`,
    );
  }

  return lines;
}

// ── GitHub Actions widget helper ──────────────────────────────────────

/**
 * Format a single segment for the GitHub Actions widget pill.
 * Renders icon + label + relative/elapsed time per ADR 0004.
 */
function formatGhWidgetSegment(status: GitHubWidgetStatus): string {
  // Error states
  if (status.error === "auth") {
    return `${GH_ICONS.auth_error} GH auth error`;
  }
  if (status.error === "api") {
    return `${GH_ICONS.api_error} GH API error`;
  }

  // No runs yet
  if (!status.run) {
    return `${GH_ICONS.no_runs} No runs yet`;
  }

  const run = status.run;

  // In-progress (running)
  if (run.status === "in_progress") {
    const icon = GH_ICONS.in_progress;
    const elapsed = run.run_started_at
      ? formatElapsed(run.run_started_at)
      : "...";
    return `${icon} Running \u00B7 ${elapsed} elapsed`;
  }

  // Queued / waiting / pending
  if (
    run.status === "queued" ||
    run.status === "waiting" ||
    run.status === "pending"
  ) {
    const icon = GH_ICONS[run.status] ?? GH_ICONS.queued;
    return `${icon} Queued \u00B7 waiting`;
  }

  // Completed — use conclusion
  if (run.status === "completed" && run.conclusion) {
    const icon =
      GH_ICONS[run.conclusion] ?? "\uF059";
    const color =
      GH_COLORS[run.conclusion] ?? "#9CA3AF";
    const label =
      GH_LABELS[run.conclusion] ?? run.conclusion;
    const relative = formatRelativeTime(run.updated_at || run.created_at);
    return `${hexToAnsi(color, icon)} ${hexToAnsi(color, `${label} \u00B7 ${relative}`)}`;
  }

  // Fallback: just show the status
  const icon = GH_ICONS[run.status ?? ""] ?? "\uF059";
  return `${icon} ${run.status ?? "unknown"}`;
}

// ── overlay component ────────────────────────────────────────────────

export class UnifiedOverlay {
  private allIssues: UnifiedIssue[];
  private filteredIssues: UnifiedIssue[] = [];
  private filter: IssueFilter = "all";
  private stateGroupFilter: StateGroupFilter = "all";
  private selected = 0;
  private selectedSet: Set<string> = new Set(); // Plane issue IDs for bulk ops
  private scrollOffset = 0;
  private visibleHeight = 0;
  private detailIssue: UnifiedIssue | null = null;
  private detailScroll = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private projectIdentifier: string | null;
  private theme: {
    fg: (color: string, text: string) => string;
    bg: (color: string, text: string) => string;
  };
  private onClose: () => void;
  private onToggleTime: (issue: UnifiedIssue) => void;
  private getRunningEntryPlaneId: () => string | null;
  private getAccumulatedMsFn: (issueId: string) => number;
  private getTimeEntriesForIssue: (issueId: string) => TimeEntry[];
  private onFilterChange?: () => void;
  private readSentryDetail: (detailFile: string) => Record<
    string,
    unknown
  > | null;
  private cwd: string;

  // Dropdown state
  private onChangeState: ((issue: UnifiedIssue, newStateId: string) => void) | null = null;
  private onBulkChangeState: ((issueIds: string[], newStateId: string) => void) | null = null;
  private dropdownStates: PlaneStateItem[] = [];
  private dropdownOpen = false;
  private dropdownIndex = 0;
  private dropdownIssue: UnifiedIssue | null = null;

  // Create-issue input mode
  private inputMode = false;
  private inputBuffer = "";
  private onCreate: ((title: string) => Promise<boolean>) | null = null;

  /** Set by the TUI factory to trigger re-renders from async callbacks. */
  requestRender: (() => void) | null = null;

  constructor(
    issues: UnifiedIssue[],
    theme: {
      fg: (color: string, text: string) => string;
      bg: (color: string, text: string) => string;
    },
    onClose: () => void,
    projectIdentifier: string | null,
    onToggleTime: (issue: UnifiedIssue) => void,
    getRunningEntryPlaneId: () => string | null,
    getAccumulatedMsFn: (issueId: string) => number,
    getTimeEntriesForIssue: (issueId: string) => TimeEntry[],
    cwd: string,
    onChangeState?: (issue: UnifiedIssue, newStateId: string) => void,
    onBulkChangeState?: (issueIds: string[], newStateId: string) => void,
    onCreate?: (title: string) => Promise<boolean>,
  ) {
    this.allIssues = issues;
    this.theme = theme;
    this.onClose = onClose;
    this.projectIdentifier = projectIdentifier;
    this.onToggleTime = onToggleTime;
    this.getRunningEntryPlaneId = getRunningEntryPlaneId;
    this.getAccumulatedMsFn = getAccumulatedMsFn;
    this.getTimeEntriesForIssue = getTimeEntriesForIssue;
    this.cwd = cwd;
    this.readSentryDetail = (detailFile: string) => {
      if (!detailFile) return null;
      const fullPath = path.join(this.cwd, detailFile);
      try {
        return JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      } catch {
        return null;
      }
    };
    this.onChangeState = onChangeState ?? null;
    this.onBulkChangeState = onBulkChangeState ?? null;
    this.onCreate = onCreate ?? null;
    this.applyFilter();
  }

  /** Update the States list available for the dropdown. */
  setStates(states: PlaneStateItem[]): void {
    this.dropdownStates = [...states];
  }

  private openDropdown(): void {
    if (this.dropdownStates.length === 0) return;

    const isBulk = this.selectedSet.size > 0 && this.detailIssue === null;

    // In bulk mode, pick the first selected issue as the reference for pre-selection
    const issue = isBulk
      ? this.allIssues.find(
          (i) => i.source === "plane" && i.id != null && this.selectedSet.has(i.id),
        ) ?? null
      : (this.detailIssue ?? this.filteredIssues[this.selected]);

    if (!issue || issue.source !== "plane") return;

    // Sort states by group order (backlog → completed → cancelled)
    const groupOrder = [
      "backlog",
      "unstarted",
      "started",
      "triage",
      "completed",
      "cancelled",
    ];
    const sorted = [...this.dropdownStates].sort((a, b) => {
      const gA = groupOrder.indexOf(a.group);
      const gB = groupOrder.indexOf(b.group);
      if (gA !== gB) return (gA === -1 ? 999 : gA) - (gB === -1 ? 999 : gB);
      return a.name.localeCompare(b.name);
    });
    this.dropdownStates = sorted;

    // Pre-select current state of the reference issue
    const currentId = issue.state_id;
    const currentIdx = this.dropdownStates.findIndex(
      (s) => s.id === currentId,
    );
    this.dropdownIndex = currentIdx >= 0 ? currentIdx : 0;
    // In bulk mode, dropdownIssue stays null (no single issue highlighted with ✓)
    this.dropdownIssue = isBulk ? null : issue;
    this.dropdownOpen = true;
    this.invalidate();
  }

  updateIssues(issues: UnifiedIssue[]): void {
    this.allIssues = issues;
    this.applyFilter();
    this.invalidate();
  }

  private applyFilter(): void {
    let issues = this.allIssues;

    // Source filter
    if (this.filter !== "all") {
      issues = issues.filter((i) => i.source === this.filter);
    }

    // State-group filter (Plane only; Sentry always passes)
    if (this.stateGroupFilter !== "all") {
      issues = issues.filter((i) => {
        if (i.source === "sentry") return true;
        return i.state_group === this.stateGroupFilter;
      });
    } else {
      // "All" = active groups only (backlog, unstarted, started, triage)
      issues = issues.filter((i) => {
        if (i.source === "sentry") return true;
        return i.state_group ? ACTIVE_GROUPS.has(i.state_group) : true;
      });
    }

    this.filteredIssues = issues;
    this.selected = 0;
    this.scrollOffset = 0;
    this.detailIssue = null;
    this.detailScroll = 0;
    this.invalidate();
  }

  private cycleStateGroupFilter(delta: 1 | -1): void {
    const idx = STATE_GROUP_CYCLE.indexOf(this.stateGroupFilter);
    this.stateGroupFilter =
      STATE_GROUP_CYCLE[
        (idx + delta + STATE_GROUP_CYCLE.length) % STATE_GROUP_CYCLE.length
      ];
    this.applyFilter();
  }

  /** Set the current filter and re-apply. Used externally after issue creation. */
  setFilter(filter: IssueFilter): void {
    if (this.filter !== filter) {
      this.filter = filter;
      this.applyFilter();
    }
  }

  handleInput(data: string): void {
    // Dropdown mode — only dropdown keys respond
    if (this.dropdownOpen) {
      if (matchesKey(data, Key.escape)) {
        this.dropdownOpen = false;
        this.dropdownIssue = null;
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const state = this.dropdownStates[this.dropdownIndex];
        if (state && this.selectedSet.size > 0 && this.onBulkChangeState) {
          // Bulk mode: pass all selected IDs to the bulk handler
          const ids = [...this.selectedSet];
          this.selectedSet.clear();
          this.onBulkChangeState(ids, state.id);
        } else if (state && this.dropdownIssue && this.onChangeState) {
          this.onChangeState(this.dropdownIssue, state.id);
        }
        this.dropdownOpen = false;
        this.dropdownIssue = null;
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.up)) {
        if (this.dropdownIndex > 0) {
          this.dropdownIndex--;
          this.invalidate();
        }
        return;
      }
      if (matchesKey(data, Key.down)) {
        if (this.dropdownIndex < this.dropdownStates.length - 1) {
          this.dropdownIndex++;
          this.invalidate();
        }
        return;
      }
      return;
    }

    // Input mode — capture input for new issue creation
    if (this.inputMode) {
      // Escape → cancel
      if (matchesKey(data, Key.escape)) {
        this.inputMode = false;
        this.inputBuffer = "";
        this.invalidate();
        return;
      }

      // Enter → submit (only if buffer non-empty)
      if (matchesKey(data, Key.enter)) {
        if (this.inputBuffer.length === 0) {
          // Empty title — same as cancel
          this.inputMode = false;
          this.inputBuffer = "";
          this.invalidate();
          return;
        }
        // Call onCreate callback (fire-and-forget)
        const title = this.inputBuffer;
        this.inputMode = false;
        this.inputBuffer = "";
        this.invalidate();
        if (this.onCreate) {
          this.onCreate(title)
            .then(() => {
              this.requestRender?.();
            })
            .catch(() => {});
        }
        return;
      }

      // Backspace
      if (matchesKey(data, Key.backspace)) {
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.invalidate();
        }
        return;
      }

      // Printable characters
      const kittyChar = decodeKittyPrintable(data);
      if (kittyChar !== undefined) {
        this.inputBuffer += kittyChar;
        this.invalidate();
        return;
      }

      // Legacy terminal fallback: single printable ASCII character
      if (data.length === 1) {
        const code = data.charCodeAt(0);
        if (code >= 32 && code <= 126) {
          this.inputBuffer += data;
          this.invalidate();
          return;
        }
      }

      return;
    }

    // n → enter create-issue input mode
    if (matchesKey(data, "n")) {
      this.inputMode = true;
      this.inputBuffer = "";
      this.detailIssue = null;
      this.detailScroll = 0;
      this.invalidate();
      return;
    }

    // d → open state change dropdown (Plane issues only)
    // In list view: bulk-change all selected if any, otherwise single issue.
    // In detail view: always single-issue, ignoring bulk selection.
    if (matchesKey(data, "d")) {
      if (this.detailIssue !== null) {
        if (this.detailIssue.source === "plane") {
          this.openDropdown();
        }
        return;
      }
      if (this.selectedSet.size > 0) {
        this.openDropdown();
      } else {
        const issue = this.filteredIssues[this.selected];
        if (issue && issue.source === "plane") {
          this.openDropdown();
        }
      }
      return;
    }

    // Ctrl+Enter → open URL
    if (matchesKey(data, Key.ctrl("enter"))) {
      const issue = this.detailIssue ?? this.filteredIssues[this.selected];
      if (issue) openUrl(issue.link);
      return;
    }

    // c → copy identifier
    if (matchesKey(data, "c")) {
      const issue = this.detailIssue ?? this.filteredIssues[this.selected];
      if (issue) {
        const id =
          issue.source === "plane"
            ? this.projectIdentifier
              ? `${this.projectIdentifier}-${issue.sequence_id}`
              : `#${issue.sequence_id}`
            : `sentry-${issue.sentry_id}`;
        copyToClipboard(id);
      }
      return;
    }

    // s → toggle time (plane only)
    if (matchesKey(data, "s")) {
      const issue = this.detailIssue ?? this.filteredIssues[this.selected];
      if (issue && issue.source === "plane") {
        this.onToggleTime(issue);
      }
      return;
    }

    // f → cycle filter
    if (matchesKey(data, "f")) {
      const idx = FILTER_CYCLE.indexOf(this.filter);
      this.filter = FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length];
      this.applyFilter();
      if (this.onFilterChange) this.onFilterChange();
      return;
    }

    // ← → cycle state-group filter
    if (matchesKey(data, Key.left)) {
      this.cycleStateGroupFilter(-1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.cycleStateGroupFilter(1);
      return;
    }

    // Detail view keys
    if (this.detailIssue !== null) {
      if (matchesKey(data, Key.escape)) {
        this.detailIssue = null;
        this.detailScroll = 0;
      } else if (
        matchesKey(data, Key.down) ||
        matchesKey(data, Key.pageDown)
      ) {
        this.detailScroll++;
      } else if (
        matchesKey(data, Key.up) ||
        matchesKey(data, Key.pageUp)
      ) {
        this.detailScroll = Math.max(0, this.detailScroll - 1);
      } else if (matchesKey(data, Key.home)) {
        this.detailScroll = 0;
      }
      return;
    }

    // Space → toggle multi-select (Plane only, list view only)
    if (matchesKey(data, Key.space)) {
      const issue = this.filteredIssues[this.selected];
      if (issue && issue.source === "plane" && issue.id != null) {
        if (this.selectedSet.has(issue.id)) {
          this.selectedSet.delete(issue.id);
        } else {
          this.selectedSet.add(issue.id);
        }
        this.invalidate();
      }
      return;
    }

    // List view keys
    if (matchesKey(data, Key.up)) {
      if (this.selected > 0) {
        this.selected--;
        this.ensureVisible();
      }
    } else if (matchesKey(data, Key.down)) {
      if (this.selected < this.filteredIssues.length - 1) {
        this.selected++;
        this.ensureVisible();
      }
    } else if (matchesKey(data, Key.enter)) {
      const issue = this.filteredIssues[this.selected];
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
      this.selected = this.filteredIssues.length - 1;
      this.ensureVisible();
    } else if (matchesKey(data, Key.pageUp)) {
      this.selected = Math.max(
        0,
        this.selected - this.visibleHeight,
      );
      this.ensureVisible();
    } else if (matchesKey(data, Key.pageDown)) {
      const max = this.filteredIssues.length - 1;
      this.selected = Math.min(
        max,
        this.selected + this.visibleHeight,
      );
      this.ensureVisible();
    }
  }

  private ensureVisible(): void {
    if (this.selected < this.scrollOffset) {
      this.scrollOffset = this.selected;
    } else if (
      this.selected >=
      this.scrollOffset + this.visibleHeight
    ) {
      this.scrollOffset = this.selected - this.visibleHeight + 1;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    if (this.dropdownOpen) {
      const dropdownLines = this.renderDropdown(width);
      this.cachedWidth = width;
      this.cachedLines = dropdownLines;
      return dropdownLines;
    }

    if (this.inputMode) {
      const inputLines = this.renderInputMode(width);
      this.cachedWidth = width;
      this.cachedLines = inputLines;
      return inputLines;
    }

    if (this.detailIssue) {
      const detailLines = this.renderDetailMode(width);
      this.cachedWidth = width;
      this.cachedLines = detailLines;
      return detailLines;
    }

    const lines: string[] = [];
    const t = this.theme;
    const B = (s: string) => t.fg("border", s);
    const innerW = Math.max(1, width - 2);

    // ── top border ───────────────────────────────────────────────
    const planeCount = this.allIssues.filter(
      (i) => i.source === "plane",
    ).length;
    const sentryCount = this.allIssues.filter(
      (i) => i.source === "sentry",
    ).length;
    const title = `Issues (${this.filteredIssues.length}) [${FILTER_LABELS[this.filter]} \u00B7 ${STATE_GROUP_LABELS[this.stateGroupFilter]}] `;
    const topDash = Math.max(0, innerW - visibleWidth(title) - 3);
    lines.push(
      B("\u250C\u2500 ") +
        t.fg("accent", title) +
        B(" " + "\u2500".repeat(topDash) + "\u2510"),
    );

    // ── header row ───────────────────────────────────────────────
    const slugW = 10;
    const stateW = 12;
    const priorityW = 10;
    const gapW = 6;
    const headerTitleW =
      innerW - slugW - stateW - priorityW - gapW;
    const rowTitleW = headerTitleW - 1; // reserve 1 for row prefix (chevron/space)

    if (headerTitleW < 10) {
      const narrowTitle = padOrTrunc(
        "Terminal too narrow",
        innerW,
      );
      lines.push(
        B("\u2502") + t.fg("muted", narrowTitle) + B("\u2502"),
      );
      const showIssues = this.filteredIssues.slice(
        0,
        Math.min(10, this.filteredIssues.length),
      );
      for (const iss of showIssues) {
        const id =
          iss.source === "plane"
            ? `#${iss.sequence_id}`
            : `s${iss.sentry_id}`;
        const row = padOrTrunc(`[${id}] ${iss.title}`, innerW);
        lines.push(B("\u2502") + row + B("\u2502"));
      }
      const remaining = this.filteredIssues.length - 10;
      if (remaining > 0) {
        const info = padOrTrunc(
          `\u2026 and ${remaining} more`,
          innerW,
        );
        lines.push(
          B("\u2502") + t.fg("muted", info) + B("\u2502"),
        );
      }
      lines.push(
        B("\u2514" + "\u2500".repeat(innerW) + "\u2518"),
      );
      return lines.map((l) => truncateToWidth(l, width));
    }

    const header =
      padOrTrunc("ID", slugW) +
      "  " +
      padOrTrunc("Title", headerTitleW) +
      "  " +
      padOrTrunc("State/Level", stateW) +
      "  " +
      padOrTrunc("Pri/Status", priorityW);
    lines.push(
      B("\u2502") + t.fg("muted", header) + B("\u2502"),
    );

    // ── header-body separator ────────────────────────────────────
    lines.push(
      B("\u251C" + "\u2500".repeat(innerW) + "\u2524"),
    );

    // ── issue rows ───────────────────────────────────────────────
    const maxVisible = Math.min(
      25,
      Math.max(5, Math.floor(innerW * 0.5)),
    );
    this.visibleHeight = maxVisible;

    const endIdx = Math.min(
      this.scrollOffset + maxVisible,
      this.filteredIssues.length,
    );
    const displayIssues = this.filteredIssues.slice(
      this.scrollOffset,
      endIdx,
    );

    for (let i = 0; i < displayIssues.length; i++) {
      const idx = this.scrollOffset + i;
      const issue = displayIssues[i];
      const isSelected = idx === this.selected;
      const isBulkSelected =
        issue.source === "plane" &&
        issue.id != null &&
        this.selectedSet.has(issue.id);
      const runningId = this.getRunningEntryPlaneId();
      const isTimed =
        issue.source === "plane" &&
        runningId !== null &&
        issue.id === runningId;

      const idStr =
        issue.source === "plane"
          ? issue.sequence_id != null
            ? this.projectIdentifier
              ? `${this.projectIdentifier}-${issue.sequence_id}`
              : `#${issue.sequence_id}`
            : issue.id?.slice(0, 8) ?? "?"
          : `#${issue.sentry_id}`;
      const sourceIcon = issue.source === "plane" ? "\uF273" : "\uF188";
      const slugStr = padOrTrunc(`${sourceIcon} ${idStr}`, slugW);
      const titleStr = padOrTrunc(issue.title, rowTitleW);

      // State/Level column
      let typeCol: string;
      if (issue.source === "plane") {
        typeCol = statePill(
          issue.state_hex ?? "#808080",
          padOrTrunc(issue.state_name ?? "?", stateW - 2),
        );
      } else {
        typeCol = sentryLevelLabel(
          padOrTrunc(issue.level ?? "?", stateW),
        );
      }

      // Priority/Status column
      let subCol: string;
      if (issue.source === "plane") {
        subCol = priorityLabel(
          padOrTrunc(issue.priority ?? "none", priorityW),
        );
      } else {
        subCol = padOrTrunc(
          issue.sentry_status ?? "?",
          priorityW,
        );
      }

      const timePrefix = isTimed ? "\uF054" : isSelected ? "\uF054" : " ";
      const row = `${slugStr}  ${titleStr}  ${typeCol}  ${subCol}`;
      const rowVis = visibleWidth(`${timePrefix}${row}`);

      if (isSelected || isTimed) {
        const content = isSelected
          ? t.bg(
              "selectedBg",
              t.fg("text", `${timePrefix}${row}`),
            )
          : t.bg(
              "selectedBg",
              t.fg("dim", `${timePrefix}${row}`),
            );
        const padLen = Math.max(0, innerW - rowVis);
        lines.push(
          B("\u2502") +
            content +
            " ".repeat(padLen) +
            B("\u2502"),
        );
      } else if (isBulkSelected) {
        // Multi-select highlight: accent foreground on selectedBg
        const content = t.bg(
          "selectedBg",
          t.fg("accent", ` ${row}`),
        );
        const padLen = Math.max(0, innerW - rowVis);
        lines.push(
          B("\u2502") +
            content +
            " ".repeat(padLen) +
            B("\u2502"),
        );
      } else {
        const padLen = Math.max(0, innerW - rowVis);
        lines.push(
          B("\u2502") + ` ${row}` + " ".repeat(padLen) + B("\u2502"),
        );
      }
    }

    // ── scroll indicator ─────────────────────────────────────────
    if (endIdx < this.filteredIssues.length) {
      const remaining = this.filteredIssues.length - endIdx;
      const indicator = padOrTrunc(
        `\uF103 ${remaining} more`,
        innerW,
      );
      lines.push(
        B("\u2502") + t.fg("muted", indicator) + B("\u2502"),
      );
    }

    // ── body-footer separator ────────────────────────────────────
    lines.push(
      B("\u251C" + "\u2500".repeat(innerW) + "\u2524"),
    );

    // ── footer ───────────────────────────────────────────────────
    const footerLines = wrapText(
      "\uF102 \uF103 scroll  n new issue  Enter preview  Space select  s start/stop (Plane)  d change state (Plane)  f source  \u2190\u2192 group  Ctrl+Enter open  c copy  Esc close",
      innerW,
    );
    for (const fl of footerLines) {
      lines.push(B("\u2502") + t.fg("dim", truncateToWidth(fl, innerW, "", true)) + B("\u2502"));
    }

    // ── bottom border ────────────────────────────────────────────
    lines.push(
      B("\u2514" + "\u2500".repeat(innerW) + "\u2518"),
    );

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines.map((l) => truncateToWidth(l, width));
  }

  // ── dropdown modal ─────────────────────────────────────────────────

  private renderDropdown(width: number): string[] {
    const t = this.theme;
    const B = (s: string) => t.fg("border", s);
    const innerW = Math.max(1, width - 2);
    const lines: string[] = [];

    // ── top border ───────────────────────────────────────────────
    const isBulk = this.dropdownIssue === null && this.selectedSet.size > 0;
    const title = isBulk
      ? `Change State (${this.selectedSet.size} selected) `
      : `Change State `;
    const topDash = Math.max(0, innerW - visibleWidth(title) - 3);
    lines.push(
      B("\u250C\u2500 ") +
        t.fg("accent", title) +
        B(" " + "\u2500".repeat(topDash) + "\u2510"),
    );

    // ── hint row ─────────────────────────────────────────────────
    const hint = "\uF102\uF103 navigate  Enter select  Esc cancel";
    const hintPad = Math.max(0, innerW - visibleWidth(hint));
    lines.push(
      B("\u2502") + t.fg("dim", hint) + " ".repeat(hintPad) + B("\u2502"),
    );

    // ── separator ────────────────────────────────────────────────
    lines.push(
      B("\u251C" + "\u2500".repeat(innerW) + "\u2524"),
    );

    // ── state rows ───────────────────────────────────────────────
    const currentId = this.dropdownIssue?.state_id;
    for (let i = 0; i < this.dropdownStates.length; i++) {
      const state = this.dropdownStates[i];
      const isSelected = i === this.dropdownIndex;
      const isCurrent = state.id === currentId;

      const pill = statePill(state.color, ` ${state.name} `);
      const indicator = isCurrent ? " \u2713" : "  ";
      const row = `${isSelected ? "\uF054 " : "  "}${pill}${indicator}`;
      const rowVis = visibleWidth(row);

      if (isSelected) {
        const content = t.bg("selectedBg", t.fg("text", row));
        const padLen = Math.max(0, innerW - rowVis);
        lines.push(
          B("\u2502") + content + " ".repeat(padLen) + B("\u2502"),
        );
      } else {
        const padLen = Math.max(0, innerW - rowVis);
        lines.push(
          B("\u2502") + row + " ".repeat(padLen) + B("\u2502"),
        );
      }
    }

    // ── bottom border ────────────────────────────────────────────
    lines.push(
      B("\u2514" + "\u2500".repeat(innerW) + "\u2518"),
    );

    return lines.map((l) => truncateToWidth(l, width));
  }

  // ── create-issue input mode ─────────────────────────────────────────

  private renderInputMode(width: number): string[] {
    const t = this.theme;
    const B = (s: string) => t.fg("border", s);
    const innerW = Math.max(1, width - 2);
    const lines: string[] = [];

    // ── top border ───────────────────────────────────────────────
    const title = "New Issue ";
    const topDash = Math.max(0, innerW - visibleWidth(title) - 3);
    lines.push(
      B("\u250C\u2500 ") +
        t.fg("accent", title) +
        B(" " + "\u2500".repeat(topDash) + "\u2510"),
    );

    // ── hint row ─────────────────────────────────────────────────
    const hint = "Enter a title for the new issue…";
    const hintPad = Math.max(0, innerW - hint.length);
    lines.push(
      B("\u2502") + t.fg("dim", hint) + " ".repeat(hintPad) + B("\u2502"),
    );

    // ── separator ────────────────────────────────────────────────
    lines.push(
      B("\u251C" + "\u2500".repeat(innerW) + "\u2524"),
    );

    // ── input field ──────────────────────────────────────────────
    const cursor = this.inputBuffer.length > 0 ? "" : " ";
    const displayText = `\uF040 ${this.inputBuffer}${cursor}`;
    const inputLine = padOrTrunc(displayText, innerW);
    const inputContent = t.bg("selectedBg", t.fg("text", inputLine));
    lines.push(
      B("\u2502") + inputContent + B("\u2502"),
    );

    // ── empty input warning for clarity (only shown when buffer is empty) ─
    if (this.inputBuffer.length === 0) {
      const emptyMsg = padOrTrunc(
        "(type a title — Enter creates, Esc cancels)",
        innerW,
      );
      lines.push(
        B("\u2502") + t.fg("muted", emptyMsg) + B("\u2502"),
      );
    }

    // ── footer ───────────────────────────────────────────────────
    lines.push(
      B("\u251C" + "\u2500".repeat(innerW) + "\u2524"),
    );
    const footerLines = wrapText(
      "Enter create  Esc cancel",
      innerW,
    );
    for (const fl of footerLines) {
      lines.push(B("\u2502") + t.fg("dim", truncateToWidth(fl, innerW, "", true)) + B("\u2502"));
    }

    // ── bottom border ────────────────────────────────────────────
    lines.push(
      B("\u2514" + "\u2500".repeat(innerW) + "\u2518"),
    );

    return lines.map((l) => truncateToWidth(l, width));
  }

  private renderDetailMode(width: number): string[] {
    const t = this.theme;
    const issue = this.detailIssue!;
    const B = (s: string) => t.fg("border", s);
    const innerW = Math.max(1, width - 2);
    const lines: string[] = [];

    // ── top border ───────────────────────────────────────────────
    const id =
      issue.source === "plane"
        ? this.projectIdentifier
          ? `${this.projectIdentifier}-${issue.sequence_id}`
          : `#${issue.sequence_id}`
        : `Sentry #${issue.sentry_id}`;
    const icon = issue.source === "plane" ? "\uF273" : "\uF188";
    const title = `${icon}: ${id}`;
    const topDash = Math.max(0, innerW - visibleWidth(title) - 3);
    lines.push(
      B("\u250C\u2500 ") +
        t.bg("selectedBg", t.fg("text", title)) +
        B(" " + "\u2500".repeat(topDash) + "\u2510"),
    );

    // ── title ────────────────────────────────────────────────────
    const titleLines = wrapText(`Title: ${issue.title}`, innerW);
    for (const tl of titleLines) {
      const tlPad = Math.max(0, innerW - visibleWidth(tl));
      lines.push(
        B("\u2502") +
          t.fg("accent", tl) +
          " ".repeat(tlPad) +
          B("\u2502"),
      );
    }

    // ── meta ─────────────────────────────────────────────────────
    if (issue.source === "plane") {
      const coloredState = statePill(
        issue.state_hex ?? "#808080",
        issue.state_name ?? "?",
      );
      const coloredPriority = priorityLabel(
        issue.priority ?? "none",
      );
      const accMs = this.getAccumulatedMsFn(issue.id!);
      const accStr =
        accMs > 0
          ? `  ${t.fg("muted", "\u00B7 Total:")} ${formatDuration(accMs)}`
          : "";
      const meta = `${coloredState}  ${t.fg("muted", "\u00B7 Priority: ")}${coloredPriority}${accStr}`;
      const metaPad = Math.max(
        0,
        innerW - visibleWidth(meta),
      );
      lines.push(
        B("\u2502") + meta + " ".repeat(metaPad) + B("\u2502"),
      );
    } else {
      const levelLabel = sentryLevelLabel(issue.level ?? "?");
      const statusPart = issue.sentry_status ?? "?";
      const countPart =
        issue.count != null ? `  \u00B7 Events: ${issue.count}` : "";
      const meta = `${levelLabel}  ${t.fg("muted", "\u00B7 Status:")} ${statusPart}${countPart}`;
      const metaPad = Math.max(
        0,
        innerW - visibleWidth(meta),
      );
      lines.push(
        B("\u2502") + meta + " ".repeat(metaPad) + B("\u2502"),
      );

      if (issue.culprit) {
        const culprit = `Culprit: ${issue.culprit}`;
        const cPad = Math.max(0, innerW - visibleWidth(culprit));
        lines.push(
          B("\u2502") +
            t.fg("dim", culprit) +
            " ".repeat(cPad) +
            B("\u2502"),
        );
      }
    }

    // ── separator ────────────────────────────────────────────────
    lines.push(
      B("\u251C" + "\u2500".repeat(innerW) + "\u2524"),
    );

    // ── content ──────────────────────────────────────────────────
    const contentLines: string[] = [];

    if (issue.source === "plane") {
      // Description
      const descHdr = padOrTrunc("\uF040 Description:", innerW);
      contentLines.push(descHdr);
      contentLines.push("");
      const desc = issue.description || "(no description)";
      for (const dl of wrapText(desc, innerW)) {
        contentLines.push(dl);
      }

      // Time entries
      const entries = this.getTimeEntriesForIssue(issue.id!);
      if (entries.length > 0) {
        contentLines.push("");
        contentLines.push("\uF252 Time Entries:");

        const numW = 3;
        const timeW = 13;
        const durW = 10;
        const availTableW =
          innerW - numW - timeW * 2 - durW - 8;

        if (availTableW >= 0) {
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
              `  ${i + 1}. ${started} \u2192 ${stopped} (${dur})`,
            );
          }
        }
      }
    } else {
      // Sentry detail: load from detail file
      const detailFile = issue.detail_file;
      if (detailFile) {
        const detail = this.readSentryDetail(detailFile);
        if (detail) {
          const data = detail;
          const sentryIssue = data.issue as
            | Record<string, unknown>
            | undefined;
          const latest = data.latest_event_summary as
            | Record<string, unknown>
            | undefined;
          const full = data.full_event as
            | Record<string, unknown>
            | null
            | undefined;

          contentLines.push("Sentry Issue Details:");
          contentLines.push("");

          if (sentryIssue) {
            contentLines.push(
              `First seen: ${sentryIssue.firstSeen ?? "?"}`,
            );
            contentLines.push(
              `Last seen: ${sentryIssue.lastSeen ?? "?"}`,
            );
            if (sentryIssue.type) {
              contentLines.push(
                `Type: ${sentryIssue.type}`,
              );
            }
            contentLines.push("");
          }

          if (latest?.tags) {
            const tags = latest.tags as Array<
              [string, string]
            >;
            if (tags.length > 0) {
              contentLines.push(
                `Tags: ${tags.map((t) => `${t[0]}=${t[1]}`).join(", ")}`,
              );
              contentLines.push("");
            }
          }

          // Stack trace from full event
          if (full?.entries) {
            for (const entry of full.entries as Array<
              Record<string, unknown>
            >) {
              if (entry.type !== "exception") continue;
              const excData = entry.data as Record<
                string,
                unknown
              >;
              const values = excData?.values as
                | Array<Record<string, unknown>>
                | undefined;
              if (!values) continue;
              for (const exc of values) {
                contentLines.push(
                  `Exception: ${exc.type}: ${exc.value}`,
                );
                contentLines.push("");
                const stacktrace = exc.stacktrace as
                  | Record<string, unknown>
                  | undefined;
                const frames = stacktrace?.frames as
                  | Array<Record<string, unknown>>
                  | undefined;
                if (!frames) continue;
                contentLines.push("\uF121 Stack frames:");
                for (const f of frames.slice(-15)) {
                  const ctxArr = f.context as
                    | Array<[number, string]>
                    | undefined;
                  const ctxLine =
                    ctxArr
                      ?.find((c) => c[0] === f.lineNo)
                      ?.[1]
                      ?.trim() ?? "";
                  contentLines.push(
                    `  ${f.filename}:${f.lineNo} in ${f.function}  ${ctxLine}`,
                  );
                }
                contentLines.push("");
              }
            }
          }

          // Breadcrumbs
          if (full?.breadcrumbs) {
            const crumbs = full.breadcrumbs as Array<
              Record<string, unknown>
            >;
            if (crumbs.length > 0) {
              contentLines.push(
                `\uF0F1 Breadcrumbs (${crumbs.length}):`,
              );
              for (const bc of crumbs.slice(-10)) {
                contentLines.push(
                  `  ${bc.timestamp ?? "?"} ${bc.category ?? ""} ${bc.message ?? ""}`,
                );
              }
              contentLines.push("");
            }
          }

          // Request context
          if (full?.request) {
            const req = full.request as Record<
              string,
              unknown
            >;
            if (req.url || req.method) {
              contentLines.push(
                `\uF0EC Request: ${req.method ?? "GET"} ${req.url ?? ""}`,
              );
              contentLines.push("");
            }
          }
        }
      }
    }

    // ── scroll content ───────────────────────────────────────────
    const chromeRows =
      1 + titleLines.length + 1 + 1 + 1 + 1 + 1;
    const viewH =
      this.visibleHeight ||
      Math.min(25, Math.max(5, Math.floor(width * 0.5)));
    const availContentH = Math.max(3, viewH - chromeRows);

    const maxScroll = Math.max(
      0,
      contentLines.length - availContentH,
    );
    this.detailScroll = Math.max(
      0,
      Math.min(this.detailScroll, maxScroll),
    );

    const endIdx = Math.min(
      this.detailScroll + availContentH,
      contentLines.length,
    );
    for (let i = this.detailScroll; i < endIdx; i++) {
      const cl = contentLines[i];
      const clPad = Math.max(0, innerW - visibleWidth(cl));
      lines.push(
        B("\u2502") + cl + " ".repeat(clPad) + B("\u2502"),
      );
    }

    if (endIdx < contentLines.length) {
      const indicator = `\uF103 ${contentLines.length - endIdx} more lines`;
      const indPad = Math.max(0, innerW - indicator.length);
      lines.push(
        B("\u2502") +
          t.fg("muted", indicator) +
          " ".repeat(indPad) +
          B("\u2502"),
      );
    }

    // ── separator ────────────────────────────────────────────────
    lines.push(
      B("\u251C" + "\u2500".repeat(innerW) + "\u2524"),
    );

    // ── footer ───────────────────────────────────────────────────
    const footerLines = wrapText(
      "Esc back  n new issue  \uF102 \uF103 scroll  d change state (Plane)  Ctrl+Enter open  c copy",
      innerW,
    );
    for (const fl of footerLines) {
      lines.push(B("\u2502") + t.fg("dim", truncateToWidth(fl, innerW, "", true)) + B("\u2502"));
    }

    // ── bottom border ────────────────────────────────────────────
    lines.push(
      B("\u2514" + "\u2500".repeat(innerW) + "\u2518"),
    );

    return lines.map((l) => truncateToWidth(l, width));
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ── Times Overlay ────────────────────────────────────────────────────

export class TimesOverlay {
  private rows: DashboardRow[] = [];
  private selected = 0;
  private scrollOffset = 0;
  private visibleHeight = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private theme: {
    fg: (color: string, text: string) => string;
    bg: (color: string, text: string) => string;
  };
  private onClose: () => void;
  private totalHours: number;
  private syncError: string | null;
  private utcOffset: number;

  constructor(
    rows: DashboardRow[],
    totalHours: number,
    theme: {
      fg: (color: string, text: string) => string;
      bg: (color: string, text: string) => string;
    },
    onClose: () => void,
    utcOffset: number,
    syncError?: string | null,
  ) {
    this.rows = rows;
    this.totalHours = totalHours;
    this.theme = theme;
    this.onClose = onClose;
    this.utcOffset = utcOffset;
    this.syncError = syncError ?? null;
  }

  updateData(
    rows: DashboardRow[],
    totalHours: number,
    syncError?: string | null,
  ): void {
    this.rows = rows;
    this.totalHours = totalHours;
    this.syncError = syncError ?? null;
    this.selected = 0;
    this.scrollOffset = 0;
    this.invalidate();
  }

  handleInput(data: string): void {
    // List navigation
    if (matchesKey(data, Key.up)) {
      if (this.selected > 0) {
        this.selected--;
        this.ensureVisible();
      }
    } else if (matchesKey(data, Key.down)) {
      if (this.selected < this.rows.length - 1) {
        this.selected++;
        this.ensureVisible();
      }
    } else if (matchesKey(data, Key.home)) {
      this.selected = 0;
      this.scrollOffset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.selected = Math.max(0, this.rows.length - 1);
      this.ensureVisible();
    } else if (matchesKey(data, Key.escape)) {
      this.onClose();
    }
  }

  private ensureVisible(): void {
    if (this.selected < this.scrollOffset) {
      this.scrollOffset = this.selected;
    } else if (
      this.selected >=
      this.scrollOffset + this.visibleHeight
    ) {
      this.scrollOffset = this.selected - this.visibleHeight + 1;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const t = this.theme;
    const B = (s: string) => t.fg("border", s);
    const innerW = Math.max(1, width - 2);

    // ── top border ───────────────────────────────────────────────
    const dateStr = this.getLocalToday();
    const errorIcon = this.syncError ? " \uF06A" : "";
    const title = `Time \u2014 ${dateStr}${errorIcon} `;
    const topDash = Math.max(0, innerW - visibleWidth(title) - 3);
    lines.push(
      B("\u250C\u2500 ") +
        t.fg("accent", title) +
        B(" " + "\u2500".repeat(topDash) + "\u2510"),
    );

    // ── sync error banner ────────────────────────────────────────
    if (this.syncError) {
      const errText = `  \uF06A ${this.syncError}`;
      const errPad = Math.max(0, innerW - visibleWidth(errText));
      lines.push(
        B("\u2502") + t.fg("error", errText) + " ".repeat(errPad) + B("\u2502"),
      );
    }

    // ── column headers ───────────────────────────────────────────
    const timeW = 14;
    const durW = 10;
    const prefixW = 2;
    const descW = innerW - timeW - durW - 4 - prefixW;

    if (descW >= 10) {
      const header =
        padOrTrunc("Time", timeW) +
        "  " +
        padOrTrunc("Duration", durW) +
        "  Description";
      lines.push(
        B("\u2502") + t.fg("muted", header) + B("\u2502"),
      );
      lines.push(
        B("\u251C" + "\u2500".repeat(innerW) + "\u2524"),
      );
    } else {
      lines.push(
        B("\u2502") +
          t.fg("muted", padOrTrunc("Terminal too narrow", innerW)) +
          B("\u2502"),
      );
    }

    // ── rows ─────────────────────────────────────────────────────
    const maxVisible = Math.min(
      25,
      Math.max(5, Math.floor(innerW * 0.5)),
    );
    this.visibleHeight = maxVisible;

    if (this.rows.length === 0) {
      const empty = padOrTrunc(
        "  (no time entries for this date)",
        innerW,
      );
      lines.push(
        B("\u2502") + t.fg("dim", empty) + B("\u2502"),
      );
    } else {
      const endIdx = Math.min(
        this.scrollOffset + maxVisible,
        this.rows.length,
      );
      const displayRows = this.rows.slice(this.scrollOffset, endIdx);

      for (let i = 0; i < displayRows.length; i++) {
        const idx = this.scrollOffset + i;
        const row = displayRows[i];
        const isSelected = idx === this.selected;

        const timeStr = padOrTrunc(
          `${row.startTime} \u2192 ${row.endTime}`,
          timeW,
        );
        const durStr = padOrTrunc(row.durationLabel, durW);

        const descMax = Math.max(1, descW);
        let descStr = row.description;
        if (descStr.length > descMax) {
          descStr = descStr.slice(0, descMax - 1) + "\u2026";
        } else {
          descStr = descStr.padEnd(descMax);
        }

        // Color coding
        let timeColor: string;
        let descColor: string;
        let durColor: string;

        if (row.source === "autotask") {
          if (row.isNonBillable) {
            timeColor = t.fg("dim", timeStr);
            durColor = t.fg("dim", durStr);
            descColor = t.fg("dim", descStr);
          } else {
            timeColor = timeStr;
            durColor = durStr;
            descColor = descStr;
          }
        } else {
          // Local entry: cyan for non-running, bright cyan for running
          timeColor = t.fg("info", timeStr);
          durColor = t.fg("info", durStr);
          descColor = t.fg("info", descStr);
        }

        const isRunning = row.source === "local" && row.isRunning;

        // Chevron prefix: shown on selected row or running entry
        const prefix = isSelected || isRunning ? "\uF054 " : "  ";

        const rowContent = `${timeColor}  ${durColor}  ${descColor}`;

        if (isSelected) {
          const content = t.bg("selectedBg", t.fg("text", `${prefix}${rowContent}`));
          const rowVis = visibleWidth(
            `${prefix}${timeStr}  ${durStr}  ${descStr}`,
          );
          const padLen = Math.max(0, innerW - rowVis);
          lines.push(
            B("\u2502") + content + " ".repeat(padLen) + B("\u2502"),
          );
        } else {
          const prefixColored = isRunning ? t.fg("info", prefix) : prefix;
          const line = `${prefixColored}${rowContent}`;
          const rowVis = visibleWidth(
            `${prefix}${timeStr}  ${durStr}  ${descStr}`,
          );
          const padLen = Math.max(0, innerW - rowVis);
          lines.push(
            B("\u2502") + line + " ".repeat(padLen) + B("\u2502"),
          );
        }
      }

      // Scroll indicator
      if (endIdx < this.rows.length) {
        const remaining = this.rows.length - endIdx;
        const indicator = padOrTrunc(
          `\uF103 ${remaining} more`,
          innerW,
        );
        lines.push(
          B("\u2502") + t.fg("muted", indicator) + B("\u2502"),
        );
      }
    }

    // ── footer separator ─────────────────────────────────────────
    lines.push(
      B("\u251C" + "\u2500".repeat(innerW) + "\u2524"),
    );

    // ── footer ───────────────────────────────────────────────────
    const totalStr = `Total: ${this.totalHours.toFixed(1)}h`;
    const navStr = "Esc close";
    const footer = padOrTrunc(`${totalStr}  \u00B7  ${navStr}`, innerW);
    lines.push(B("\u2502") + t.fg("dim", footer) + B("\u2502"));

    // ── bottom border ────────────────────────────────────────────
    lines.push(
      B("\u2514" + "\u2500".repeat(innerW) + "\u2518"),
    );

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines.map((l) => truncateToWidth(l, width));
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private getLocalToday(): string {
    const now = new Date();
    const offsetMs = this.utcOffset * 60 * 60 * 1000;
    const local = new Date(now.getTime() + offsetMs);
    return local.toISOString().slice(0, 10);
  }
}

// ── GitHub Actions Overlay ──────────────────────────────────────────

type ActionsFilter = "all" | "my" | "failed";

const ACTIONS_FILTER_CYCLE: ActionsFilter[] = ["all", "my", "failed"];
const ACTIONS_FILTER_LABELS: Record<ActionsFilter, string> = {
  all: "All",
  my: "\uF007 My",
  failed: "\uF00D Failed",
};

/** Short-form labels for GitHub event types. */
const EVENT_SHORT: Record<string, string> = {
  push: "push",
  pull_request: "pull_req",
  schedule: "sched",
  workflow_dispatch: "wf_disp",
  release: "release",
  fork: "fork",
  tag: "push_tag",
  issues: "issue",
  pull_request_target: "pr_trgt",
};

export class ActionsOverlay {
  private runs: GitHubRun[] = [];
  private filter: ActionsFilter = "all";
  private filteredRuns: GitHubRun[] = [];
  private selected = 0;
  private scrollOffset = 0;
  private visibleHeight = 0;
  private detailRun: GitHubRun | null = null;
  private detailJobs: GitHubJob[] = [];
  private detailScroll = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private theme: {
    fg: (color: string, text: string) => string;
    bg: (color: string, text: string) => string;
  };
  private onClose: () => void;
  private actorLogin: string | null;
  private onFetchJobs: (runId: number) => Promise<GitHubJob[]>;
  private ownerRepo: string;

  requestRender: (() => void) | null = null;

  constructor(
    runs: GitHubRun[],
    theme: {
      fg: (color: string, text: string) => string;
      bg: (color: string, text: string) => string;
    },
    onClose: () => void,
    actorLogin: string | null,
    onFetchJobs: (runId: number) => Promise<GitHubJob[]>,
    ownerRepo: string,
  ) {
    this.runs = runs;
    this.theme = theme;
    this.onClose = onClose;
    this.actorLogin = actorLogin;
    this.onFetchJobs = onFetchJobs;
    this.ownerRepo = ownerRepo;
    this.applyFilter();
  }

  updateRuns(runs: GitHubRun[]): void {
    this.runs = runs;
    this.applyFilter();
    this.invalidate();
  }

  private applyFilter(): void {
    if (this.filter === "all") {
      this.filteredRuns = [...this.runs];
    } else if (this.filter === "my") {
      this.filteredRuns = this.runs.filter(
        (r) => r.actor_login === this.actorLogin,
      );
    } else if (this.filter === "failed") {
      this.filteredRuns = this.runs.filter(
        (r) =>
          r.conclusion === "failure" ||
          r.conclusion === "timed_out" ||
          r.conclusion === "action_required",
      );
    }
    this.selected = 0;
    this.scrollOffset = 0;
    this.detailRun = null;
    this.detailScroll = 0;
    this.invalidate();
  }

  handleInput(data: string): void {
    // Detail view
    if (this.detailRun !== null) {
      if (matchesKey(data, Key.escape)) {
        this.detailRun = null;
        this.detailJobs = [];
        this.detailScroll = 0;
        this.invalidate();
        return;
      }
      if (
        matchesKey(data, Key.down) ||
        matchesKey(data, Key.pageDown)
      ) {
        this.detailScroll++;
        this.invalidate();
        return;
      }
      if (
        matchesKey(data, Key.up) ||
        matchesKey(data, Key.pageUp)
      ) {
        this.detailScroll = Math.max(0, this.detailScroll - 1);
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.home)) {
        this.detailScroll = 0;
        this.invalidate();
        return;
      }
      // Ctrl+Enter → open in browser
      if (matchesKey(data, Key.ctrl("enter"))) {
        if (this.detailRun?.html_url) {
          openUrl(this.detailRun.html_url);
        }
        return;
      }
      return;
    }

    // List view
    if (matchesKey(data, Key.up)) {
      if (this.selected > 0) {
        this.selected--;
        this.ensureVisible();
        this.invalidate();
      }
    } else if (matchesKey(data, Key.down)) {
      if (this.selected < this.filteredRuns.length - 1) {
        this.selected++;
        this.ensureVisible();
        this.invalidate();
      }
    } else if (matchesKey(data, Key.enter)) {
      const run = this.filteredRuns[this.selected];
      if (run) {
        this.detailRun = run;
        this.detailJobs = [];
        this.detailScroll = 0;
        this.invalidate();
        // Fetch jobs async
        this.onFetchJobs(run.id)
          .then((jobs) => {
            this.detailJobs = jobs;
            this.invalidate();
            this.requestRender?.();
          })
          .catch(() => {});
      }
    } else if (matchesKey(data, Key.escape)) {
      this.onClose();
    } else if (matchesKey(data, "f")) {
      const idx = ACTIONS_FILTER_CYCLE.indexOf(this.filter);
      this.filter =
        ACTIONS_FILTER_CYCLE[
          (idx + 1) % ACTIONS_FILTER_CYCLE.length
        ];
      this.applyFilter();
    } else if (matchesKey(data, Key.home)) {
      this.selected = 0;
      this.scrollOffset = 0;
      this.invalidate();
    } else if (matchesKey(data, Key.end)) {
      this.selected = this.filteredRuns.length - 1;
      this.ensureVisible();
      this.invalidate();
    } else if (matchesKey(data, Key.pageUp)) {
      this.selected = Math.max(
        0,
        this.selected - this.visibleHeight,
      );
      this.ensureVisible();
      this.invalidate();
    } else if (matchesKey(data, Key.pageDown)) {
      const max = this.filteredRuns.length - 1;
      this.selected = Math.min(
        max,
        this.selected + this.visibleHeight,
      );
      this.ensureVisible();
      this.invalidate();
    } else if (matchesKey(data, Key.ctrl("enter"))) {
      const run = this.filteredRuns[this.selected];
      if (run?.html_url) {
        openUrl(run.html_url);
      }
    } else if (matchesKey(data, "c")) {
      const run = this.filteredRuns[this.selected];
      if (run?.html_url) {
        copyToClipboard(run.html_url);
      }
    } else if (matchesKey(data, "r")) {
      const run = this.filteredRuns[this.selected];
      if (run?.html_url) {
        // Open the re-run page (the run URL + re-run via browser)
        openUrl(run.html_url);
      }
    }
  }

  private ensureVisible(): void {
    if (this.selected < this.scrollOffset) {
      this.scrollOffset = this.selected;
    } else if (
      this.selected >=
      this.scrollOffset + this.visibleHeight
    ) {
      this.scrollOffset = this.selected - this.visibleHeight + 1;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    if (this.detailRun) {
      const result = this.renderDetail(width);
      this.cachedWidth = width;
      this.cachedLines = result;
      return result;
    }

    const result = this.renderList(width);
    this.cachedWidth = width;
    this.cachedLines = result;
    return result;
  }

  private renderList(width: number): string[] {
    const lines: string[] = [];
    const t = this.theme;
    const B = (s: string) => t.fg("border", s);
    const innerW = Math.max(1, width - 2);

    // ── top border ───────────────────────────────────────────────
    const title = `Actions (${this.filteredRuns.length}) [${ACTIONS_FILTER_LABELS[this.filter]}] `;
    const topDash = Math.max(0, innerW - visibleWidth(title) - 3);
    lines.push(
      B("\u250C\u2500 ") +
        t.fg("accent", title) +
        B(" " + "\u2500".repeat(topDash) + "\u2510"),
    );

    // ── header row ───────────────────────────────────────────────
    const statusW = 7;
    const workflowW = 16;
    const runW = 6;
    const branchW = 10;
    const eventW = 8;
    const conclusionW = 10;
    const timeW = 10;

    const headerTitleW =
      innerW - statusW - workflowW - runW - branchW - eventW - conclusionW - timeW;

    if (headerTitleW < 0 || innerW < 50) {
      // Narrow terminal — simplified view
      const narrowMsg = padOrTrunc("Terminal too narrow", innerW);
      lines.push(
        B("\u2502") + t.fg("muted", narrowMsg) + B("\u2502"),
      );
      const maxVis = Math.min(
        10,
        this.filteredRuns.length,
      );
      for (let i = 0; i < maxVis; i++) {
        const r = this.filteredRuns[i];
        const icon = getRunStatusIcon(r);
        const color = getRunStatusColor(r);
        const label = `#${r.run_number} ${r.display_title || r.name || "?"}`;
        const row = padOrTrunc(
          ` ${icon} ${label}`,
          innerW,
        );
        lines.push(
          B("\u2502") +
            hexToAnsi(color, row) +
            B("\u2502"),
        );
      }
      const remaining = this.filteredRuns.length - maxVis;
      if (remaining > 0) {
        lines.push(
          B("\u2502") +
            t.fg("muted", padOrTrunc(`\u2026 and ${remaining} more`, innerW)) +
            B("\u2502"),
        );
      }
      lines.push(
        B("\u2514" + "\u2500".repeat(innerW) + "\u2518"),
      );
      return lines.map((l) => truncateToWidth(l, width));
    }

    const header =
      padOrTrunc("Status", statusW) +
      "  " +
      padOrTrunc("Workflow", workflowW) +
      "  " +
      padOrTrunc("Run", runW) +
      "  " +
      padOrTrunc("Branch", branchW) +
      "  " +
      padOrTrunc("Event", eventW) +
      "  " +
      padOrTrunc("Conclusion", conclusionW) +
      "  " +
      padOrTrunc("Time", timeW);
    lines.push(
      B("\u2502") + t.fg("muted", header) + B("\u2502"),
    );

    // ── separator ────────────────────────────────────────────────
    lines.push(
      B("\u251C" + "\u2500".repeat(innerW) + "\u2524"),
    );

    // ── rows ─────────────────────────────────────────────────────
    const maxVisible = Math.min(
      25,
      Math.max(5, Math.floor(innerW * 0.5)),
    );
    this.visibleHeight = maxVisible;

    const endIdx = Math.min(
      this.scrollOffset + maxVisible,
      this.filteredRuns.length,
    );
    const displayRuns = this.filteredRuns.slice(
      this.scrollOffset,
      endIdx,
    );

    for (let i = 0; i < displayRuns.length; i++) {
      const idx = this.scrollOffset + i;
      const run = displayRuns[i];
      const isSelected = idx === this.selected;

      const icon = getRunStatusIcon(run);
      const color = getRunStatusColor(run);
      const statusStr = padOrTrunc(
        `${hexToAnsi(color, icon)}`,
        statusW,
      );

      const wfName = run.name || run.display_title || "?";
      const wfStr = padOrTrunc(wfName, workflowW);

      const runStr = padOrTrunc(`#${run.run_number}`, runW);

      const branch = run.head_branch ?? "?";
      const branchStr = padOrTrunc(branch, branchW);

      const eventShort =
        EVENT_SHORT[run.event] ?? run.event.slice(0, 8);
      const eventStr = padOrTrunc(eventShort, eventW);

      const conclusion =
        run.status === "completed"
          ? run.conclusion ?? "?"
          : run.status ?? "?";
      const conclusionStr = padOrTrunc(conclusion, conclusionW);

      const timeLabel = getRunTimeLabel(run);
      const timeStr = padOrTrunc(timeLabel, timeW);

      const rowContent = `${statusStr}  ${wfStr}  ${runStr}  ${branchStr}  ${eventStr}  ${conclusionStr}  ${timeStr}`;

      if (isSelected) {
        const content = t.bg(
          "selectedBg",
          t.fg("text", `\uF054 ${rowContent}`),
        );
        const rowVis = visibleWidth(`  ${rowContent}`);
        const padLen = Math.max(0, innerW - rowVis - 1);
        lines.push(
          B("\u2502") + content + " ".repeat(padLen) + B("\u2502"),
        );
      } else {
        const rowVis = visibleWidth(`  ${rowContent}`);
        const padLen = Math.max(0, innerW - rowVis - 1);
        lines.push(
          B("\u2502") +
            `  ${rowContent}` +
            " ".repeat(padLen) +
            B("\u2502"),
        );
      }
    }

    // ── scroll indicator ─────────────────────────────────────────
    if (endIdx < this.filteredRuns.length) {
      const remaining = this.filteredRuns.length - endIdx;
      const indicator = padOrTrunc(
        `\uF103 ${remaining} more`,
        innerW,
      );
      lines.push(
        B("\u2502") + t.fg("muted", indicator) + B("\u2502"),
      );
    }

    // ── footer separator ─────────────────────────────────────────
    lines.push(
      B("\u251C" + "\u2500".repeat(innerW) + "\u2524"),
    );

    // ── footer ───────────────────────────────────────────────────
    const footerLines = wrapText(
      "\uF102\uF103 scroll  Enter details  f filter  r rerun  Ctrl+Enter open  c copy  Esc close",
      innerW,
    );
    for (const fl of footerLines) {
      lines.push(
        B("\u2502") +
          t.fg("dim", truncateToWidth(fl, innerW, "", true)) +
          B("\u2502"),
      );
    }

    // ── bottom border ────────────────────────────────────────────
    lines.push(
      B("\u2514" + "\u2500".repeat(innerW) + "\u2518"),
    );

    return lines.map((l) => truncateToWidth(l, width));
  }

  private renderDetail(width: number): string[] {
    const t = this.theme;
    const run = this.detailRun!;
    const B = (s: string) => t.fg("border", s);
    const innerW = Math.max(1, width - 2);
    const lines: string[] = [];

    // ── top border ───────────────────────────────────────────────
    const icon = getRunStatusIcon(run);
    const color = getRunStatusColor(run);
    const title = `${hexToAnsi(color, icon)} ${run.name || run.display_title} #${run.run_number}`;
    const topDash = Math.max(
      0,
      innerW - visibleWidth(title) - 3,
    );
    lines.push(
      B("\u250C\u2500 ") +
        t.fg("accent", title) +
        B(" " + "\u2500".repeat(topDash) + "\u2510"),
    );

    // ── metadata banner ──────────────────────────────────────────
    const branch = run.head_branch ?? "?";
    const eventShort = EVENT_SHORT[run.event] ?? run.event;
    const conclusion =
      run.status === "completed"
        ? run.conclusion ?? "?"
        : run.status ?? "?";
    const actor = run.actor_login || "?";
    const relative = getRunTimeLabel(run);
    const meta = `${branch} \u00B7 ${eventShort} \u00B7 ${conclusion} \u00B7 triggered by ${actor} \u00B7 ${relative}`;
    const metaLines = wrapText(meta, innerW);
    for (const ml of metaLines) {
      const mlPad = Math.max(0, innerW - visibleWidth(ml));
      lines.push(
        B("\u2502") + t.fg("muted", ml) + " ".repeat(mlPad) + B("\u2502"),
      );
    }

    // ── separator ────────────────────────────────────────────────
    lines.push(
      B("\u251C" + "\u2500".repeat(innerW) + "\u2524"),
    );

    // ── jobs header ──────────────────────────────────────────────
    if (this.detailJobs.length === 0) {
      const loading = padOrTrunc(
        "  Loading jobs\u2026",
        innerW,
      );
      lines.push(
        B("\u2502") + t.fg("muted", loading) + B("\u2502"),
      );
    } else {
      const passedCount = this.detailJobs.filter(
        (j) => j.conclusion === "success" || j.conclusion === "skipped",
      ).length;
      const jobsHeader = `Jobs (${passedCount}/${this.detailJobs.length} passed)`;
      const jhPad = Math.max(
        0,
        innerW - visibleWidth(jobsHeader),
      );
      lines.push(
        B("\u2502") +
          t.fg("accent", jobsHeader) +
          " ".repeat(jhPad) +
          B("\u2502"),
      );
      lines.push(B("\u2502") + " ".repeat(innerW) + B("\u2502"));

      // ── job rows ───────────────────────────────────────────────
      const nameW = 16;
      const durW = 10;
      const concW = 12;
      const errorW = innerW - nameW - durW - concW - 10;

      const maxVisJobs = Math.min(
        20,
        Math.max(4, Math.floor(innerW * 0.4)),
      );
      const jobsEnd = Math.min(
        this.detailScroll + maxVisJobs,
        this.detailJobs.length,
      );

      for (let i = this.detailScroll; i < jobsEnd; i++) {
        const job = this.detailJobs[i];
        const jIcon = getJobIcon(job);
        const jColor = getJobColor(job);
        const jStatusIcon = padOrTrunc(
          `${hexToAnsi(jColor, jIcon)}`,
          4,
        );

        const jName = padOrTrunc(job.name, nameW);

        const jDur = job.completed_at
          ? formatDuration(
              new Date(job.completed_at).getTime() -
                new Date(job.started_at).getTime(),
            )
          : job.started_at
            ? formatElapsed(job.started_at)
            : "\u2014";
        const jDurStr = padOrTrunc(jDur, durW);

        const jConclusion =
          job.conclusion ?? job.status ?? "?";
        const jConcStr = padOrTrunc(jConclusion, concW);

        const jErrorHint =
          job.conclusion === "failure" && errorW > 5
            ? padOrTrunc(
                getJobErrorHint(job),
                errorW,
              )
            : "";

        const jobRow = `${jStatusIcon}  ${jName}  ${jDurStr}  ${jConcStr} ${jErrorHint}`;
        const jobRowVis = visibleWidth(`  ${jobRow}`);
        const jobPad = Math.max(0, innerW - jobRowVis);

        if (job.conclusion === "failure") {
          lines.push(
            B("\u2502") +
              t.fg("error", `  ${jobRow}`) +
              " ".repeat(jobPad) +
              B("\u2502"),
          );
        } else if (job.conclusion === "skipped" || job.conclusion === "cancelled") {
          lines.push(
            B("\u2502") +
              t.fg("dim", `  ${jobRow}`) +
              " ".repeat(jobPad) +
              B("\u2502"),
          );
        } else {
          lines.push(
            B("\u2502") +
              `  ${jobRow}` +
              " ".repeat(jobPad) +
              B("\u2502"),
          );
        }
      }

      if (jobsEnd < this.detailJobs.length) {
        const remaining = this.detailJobs.length - jobsEnd;
        const indicator = padOrTrunc(
          `\uF103 ${remaining} more jobs`,
          innerW,
        );
        lines.push(
          B("\u2502") +
            t.fg("muted", indicator) +
            B("\u2502"),
        );
      }
    }

    // ── separator ────────────────────────────────────────────────
    lines.push(
      B("\u251C" + "\u2500".repeat(innerW) + "\u2524"),
    );

    // ── footer ───────────────────────────────────────────────────
    const footerLines = wrapText(
      "Esc back  \uF102\uF103 scroll  Ctrl+Enter open  r rerun  c copy",
      innerW,
    );
    for (const fl of footerLines) {
      lines.push(
        B("\u2502") +
          t.fg("dim", truncateToWidth(fl, innerW, "", true)) +
          B("\u2502"),
      );
    }

    // ── bottom border ────────────────────────────────────────────
    lines.push(
      B("\u2514" + "\u2500".repeat(innerW) + "\u2518"),
    );

    return lines.map((l) => truncateToWidth(l, width));
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ── GitHub Actions helper functions ──────────────────────────────────

function getRunStatusKey(run: GitHubRun): string {
  if (run.status === "completed" && run.conclusion) {
    return run.conclusion;
  }
  return run.status ?? "queued";
}

function getRunStatusIcon(run: GitHubRun): string {
  const key = getRunStatusKey(run);
  return GH_ICONS[key] ?? GH_ICONS.queued;
}

function getRunStatusColor(run: GitHubRun): string {
  const key = getRunStatusKey(run);
  return GH_COLORS[key] ?? "#9CA3AF";
}

function getRunTimeLabel(run: GitHubRun): string {
  if (run.status === "in_progress") {
    return formatElapsed(run.run_started_at || run.created_at);
  }
  if (
    run.status === "queued" ||
    run.status === "waiting" ||
    run.status === "pending"
  ) {
    return "waiting";
  }
  return formatRelativeTime(run.updated_at || run.created_at);
}

function getJobIcon(job: GitHubJob): string {
  if (job.status === "completed" && job.conclusion) {
    return GH_ICONS[job.conclusion] ?? GH_ICONS.neutral;
  }
  return GH_ICONS[job.status] ?? GH_ICONS.in_progress;
}

function getJobColor(job: GitHubJob): string {
  if (job.status === "completed" && job.conclusion) {
    return GH_COLORS[job.conclusion] ?? "#9CA3AF";
  }
  return GH_COLORS[job.status] ?? "#9CA3AF";
}

/** Return a short error hint from the failed job (first failed step name). */
function getJobErrorHint(job: GitHubJob): string {
  if (job.steps.length === 0) return "";
  const failedStep = job.steps.find((s) => s.conclusion === "failure");
  if (failedStep) {
    return `(${failedStep.name})`;
  }
  return "";
}
