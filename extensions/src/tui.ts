import type {
  UnifiedIssue,
  IssueSource,
  PlaneCache,
  TimeEntry,
} from "./types.js";
import {
  hexToAnsi,
  priorityLabel,
  formatDuration,
  formatTimestamp,
  GROUP_ORDER,
} from "./plane.js";
import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── filter type ──────────────────────────────────────────────────────

export type IssueFilter = "all" | "plane" | "sentry";

const FILTER_CYCLE: IssueFilter[] = ["all", "plane", "sentry"];
const FILTER_LABELS: Record<IssueFilter, string> = {
  all: "All",
  plane: "Plane",
  sentry: "Sentry",
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
  if (str.length > len) return str.slice(0, len - 1) + "\u2026";
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
  updateVersion: string | null,
  repoUrl: string | null,
): string[] {
  const lines: string[] = [];

  // Line 1: counts line
  const parts: string[] = [];
  if (planeCache && planeCache.total_active > 0) {
    parts.push(
      `${planeCache.sync_error ? "[!] " : ""}${planeCache.total_active} todos`,
    );
  }
  if (sentryCount > 0) {
    parts.push(`${sentryCount} sentry`);
  }
  if (parts.length === 0) {
    lines.push("\u25C9: 0");
  } else {
    lines.push(`\u25C9: ${parts.join("  ")}`);
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
    for (const [name, { count, color }] of entries) {
      if (count === 0) continue;
      pillParts.push(
        `${hexToAnsi(color, abbreviateState(name))}: ${count}`,
      );
    }
    if (pillParts.length > 0) {
      lines.push(pillParts.join("  "));
    }
  }

  // Running entry line
  if (runningEntry) {
    const prefix = missingIssue ? "[!] " : "[T] ";
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

  // Update available line
  if (updateVersion) {
    const installCmd = repoUrl
      ? `pi install ${repoUrl}@${updateVersion}`
      : `pi install git:github.com/WaldoJoubert-GH/pi-todos@${updateVersion}`;
    lines.push(
      `[UPDATE] pi-todos ${updateVersion} available \u2014 ${installCmd}`,
    );
  }

  return lines;
}

// ── overlay component ────────────────────────────────────────────────

export class UnifiedOverlay {
  private allIssues: UnifiedIssue[];
  private filteredIssues: UnifiedIssue[] = [];
  private filter: IssueFilter = "all";
  private selected = 0;
  private scrollOffset = 0;
  private visibleHeight = 0;
  private detailIssue: UnifiedIssue | null = null;
  private detailScroll = 0;
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
    this.applyFilter();
  }

  updateIssues(issues: UnifiedIssue[]): void {
    this.allIssues = issues;
    this.applyFilter();
  }

  private applyFilter(): void {
    if (this.filter === "all") {
      this.filteredIssues = [...this.allIssues];
    } else {
      this.filteredIssues = this.allIssues.filter(
        (i) => i.source === this.filter,
      );
    }
    this.selected = 0;
    this.scrollOffset = 0;
    this.detailIssue = null;
    this.detailScroll = 0;
  }

  handleInput(data: string): void {
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
    if (this.detailIssue) {
      return this.renderDetail(width);
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
    const title = `Issues (${this.filteredIssues.length}) [${FILTER_LABELS[this.filter]}] `;
    const topDash = Math.max(0, innerW - title.length - 3);
    lines.push(
      B("\u250C\u2500 ") +
        t.fg("accent", title) +
        B(" " + "\u2500".repeat(topDash) + "\u2510"),
    );

    // ── header row ───────────────────────────────────────────────
    const slugW = 10;
    const sourceW = 3;
    const stateW = 12;
    const priorityW = 10;
    const gapW = 8;
    const headerTitleW =
      innerW - slugW - sourceW - stateW - priorityW - gapW;
    const rowTitleW = headerTitleW - 1;

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
      return lines;
    }

    const header =
      padOrTrunc("ID", slugW) +
      "  " +
      padOrTrunc("Src", sourceW) +
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
      const slugStr = padOrTrunc(idStr, slugW);
      const sourceStr = issue.source === "plane" ? "Pln" : "Snt";
      const titleStr = padOrTrunc(issue.title, rowTitleW);

      // State/Level column
      let typeCol: string;
      if (issue.source === "plane") {
        typeCol = hexToAnsi(
          issue.state_hex ?? "#808080",
          padOrTrunc(issue.state_name ?? "?", stateW),
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

      const timePrefix = isTimed ? ">" : isSelected ? ">" : " ";
      const row = `${slugStr}  ${sourceStr}  ${titleStr}  ${typeCol}  ${subCol}`;
      const rowVis = visibleWidth(`>${row}`);

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
        `\u2193 ${remaining} more`,
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
    const footer = padOrTrunc(
      "\u2191\u2193 scroll  Enter preview  s start/stop (Plane)  f filter  Ctrl+Enter open  c copy  Esc close",
      innerW,
    );
    lines.push(B("\u2502") + t.fg("dim", footer) + B("\u2502"));

    // ── bottom border ────────────────────────────────────────────
    lines.push(
      B("\u2514" + "\u2500".repeat(innerW) + "\u2518"),
    );

    return lines;
  }

  // ── detail view ──────────────────────────────────────────────────────
  private renderDetail(width: number): string[] {
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
    const title = `\u25C9: ${id}`;
    const topDash = Math.max(0, innerW - title.length - 3);
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
      const coloredState = hexToAnsi(
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
      const descHdr = padOrTrunc("Description:", innerW);
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
        contentLines.push("Time Entries:");

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
                contentLines.push("Stack frames:");
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
                `Breadcrumbs (${crumbs.length}):`,
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
                `Request: ${req.method ?? "GET"} ${req.url ?? ""}`,
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
      const indicator = `\u2193 ${contentLines.length - endIdx} more lines`;
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
    const footer = padOrTrunc(
      "Esc back  \u2191\u2193 scroll  Ctrl+Enter open  c copy",
      innerW,
    );
    lines.push(B("\u2502") + t.fg("dim", footer) + B("\u2502"));

    // ── bottom border ────────────────────────────────────────────
    lines.push(
      B("\u2514" + "\u2500".repeat(innerW) + "\u2518"),
    );

    return lines;
  }

  invalidate(): void {
    // no cache to clear
  }
}
