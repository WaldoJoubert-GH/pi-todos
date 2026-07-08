import * as os from "node:os";
import * as path from "node:path";
import type {
  AutotaskTimeRecord,
  AutotaskCache,
  ResolvedAutotaskConfig,
} from "./types.js";
import {
  loadAutotaskSecrets,
  saveAutotaskSecrets,
  resolveAutotaskConfig,
  readAutotaskCache,
  writeAutotaskCache,
  loadDevConfig,
  updateAutotaskConfig,
} from "./config.js";
import { formatDuration } from "./plane.js";

// ── constants ────────────────────────────────────────────────────────

const SECRETS_FILE = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "secrets",
  "autotask.json",
);
export const AUTOTASK_SYNC_INTERVAL_MS = 5 * 60 * 1000;

// ── setup flow ───────────────────────────────────────────────────────

export async function ensureAutotaskSetup(ctx: {
  hasUI: boolean;
  ui: {
    input(p: string): Promise<string | undefined>;
    notify(m: string, t?: string): void;
  };
  cwd: string;
}): Promise<ResolvedAutotaskConfig | null> {
  if (!ctx.hasUI) {
    console.log(
      "=== /times ===\n" +
        "To use this command interactively, run pi without --print/-p.\n\n" +
        "Manual setup:\n" +
        `  1. Save your Autotask API credentials to ${SECRETS_FILE}:\n` +
        '     { "integrationCode": "...", "username": "...", "secret": "..." }\n' +
        "  2. Create or update .dev/config.json in the project root:\n" +
        '     { "autotask": { "resourceId": 123456 } }\n' +
        "     Optionally add: \"apiBaseUrl\": \"https://...\", \"utcOffset\": 2\n",
    );
    return null;
  }

  let secrets = loadAutotaskSecrets();
  if (!secrets) {
    const code = await ctx.ui.input(
      "Enter your Autotask API Integration Code:",
    );
    if (!code || code.trim().length === 0) {
      ctx.ui.notify("No integration code — aborting.", "error");
      return null;
    }
    const username = await ctx.ui.input(
      "Enter your Autotask Username:",
    );
    if (!username || username.trim().length === 0) {
      ctx.ui.notify("No username — aborting.", "error");
      return null;
    }
    const secret = await ctx.ui.input(
      "Enter your Autotask Secret:",
    );
    if (!secret || secret.trim().length === 0) {
      ctx.ui.notify("No secret — aborting.", "error");
      return null;
    }
    secrets = {
      integrationCode: code.trim(),
      username: username.trim(),
      secret: secret.trim(),
    };
    saveAutotaskSecrets(
      secrets.integrationCode,
      secrets.username,
      secrets.secret,
    );
    ctx.ui.notify(
      "Credentials saved to ~/.pi/agent/secrets/autotask.json",
      "info",
    );
  }

  let config = loadDevConfig(ctx.cwd).autotask;
  if (!config) {
    const ridInput = await ctx.ui.input(
      "Enter your Autotask Resource ID:",
    );
    if (!ridInput || ridInput.trim().length === 0) {
      ctx.ui.notify("No resource ID — aborting.", "error");
      return null;
    }
    const rid = parseInt(ridInput.trim(), 10);
    if (isNaN(rid)) {
      ctx.ui.notify("Invalid resource ID — must be a number.", "error");
      return null;
    }
    config = { resourceId: rid };
    updateAutotaskConfig(ctx.cwd, config);
    ctx.ui.notify("Config saved to .dev/config.json", "info");
  }

  return resolveAutotaskConfig(ctx.cwd);
}

// ── timezone helpers ─────────────────────────────────────────────────

function localDateString(utcOffset: number): string {
  const now = new Date();
  const offsetMs = utcOffset * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offsetMs);
  return local.toISOString().slice(0, 10);
}

function dayBoundaryUTC(dateStr: string, utcOffset: number): {
  startUTC: string;
  endUTC: string;
} {
  // Parse YYYY-MM-DD as local midnight
  const [y, m, d] = dateStr.split("-").map(Number);
  const localStart = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const localEnd = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
  // Convert to UTC by subtracting offset
  const offsetMs = utcOffset * 60 * 60 * 1000;
  const startUTC = new Date(localStart.getTime() - offsetMs);
  const endUTC = new Date(localEnd.getTime() - offsetMs);
  return {
    startUTC: startUTC.toISOString().replace(/\.\d{3}Z$/, "Z"),
    endUTC: endUTC.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

export function getTodayDateString(utcOffset: number): string {
  return localDateString(utcOffset);
}

// ── API fetch ────────────────────────────────────────────────────────

export async function fetchAutotaskTimeEntries(
  config: ResolvedAutotaskConfig,
  date: string,
): Promise<{ items: AutotaskTimeRecord[]; error: string | null }> {
  const { startUTC, endUTC } = dayBoundaryUTC(date, config.utcOffset);

  const body = {
    filter: [
      {
        op: "eq",
        field: "resourceID",
        value: config.resourceId,
      },
      {
        op: "gte",
        field: "startDateTime",
        value: startUTC,
      },
      {
        op: "lte",
        field: "endDateTime",
        value: endUTC,
      },
    ],
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ApiIntegrationCode: config.integrationCode,
    UserName: config.username,
    Secret: config.secret,
  };

  const baseUrl = config.apiBaseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/atservicesrest/v1.0/timeentries/query`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { items: [], error: `Network error: ${msg}` };
  }

  if (!response.ok) {
    let respBody = "(no body)";
    try {
      respBody = await response.text();
    } catch {
      /* ignore */
    }
    return {
      items: [],
      error: `Autotask API error ${response.status}: ${respBody.slice(0, 500)}`,
    };
  }

  let data: { items?: AutotaskTimeRecord[] };
  try {
    data = (await response.json()) as { items?: AutotaskTimeRecord[] };
  } catch {
    return { items: [], error: "Failed to parse Autotask API response" };
  }

  const items = data.items ?? [];
  // Sort by startDateTime ascending
  items.sort(
    (a, b) =>
      new Date(a.startDateTime).getTime() -
      new Date(b.startDateTime).getTime(),
  );

  return { items, error: null };
}

// ── sync + cache ─────────────────────────────────────────────────────

export async function syncAutotask(
  cwd: string,
  config: ResolvedAutotaskConfig,
  date: string,
): Promise<AutotaskCache | null> {
  const { items, error } = await fetchAutotaskTimeEntries(config, date);

  if (error) {
    return null;
  }

  const cache: AutotaskCache = {
    fetched_at: new Date().toISOString(),
    date,
    items,
  };

  writeAutotaskCache(cwd, cache);
  return cache;
}

// ── merge autotask + local into dashboard rows ───────────────────────

export interface DashboardRow {
  source: "autotask" | "local";
  startTime: string;
  endTime: string;
  durationMs: number;
  durationLabel: string;
  description: string;
  isNonBillable: boolean;
  isRunning: boolean;
  // For local entries
  sequenceId?: number;
  issueId?: string;
  // For autotask entries
  atId?: number;
  ticketID?: number;
  hoursWorked?: number;
}

import type { TimeEntry } from "./types.js";

export function buildDashboard(
  autotaskItems: AutotaskTimeRecord[],
  localEntries: TimeEntry[],
  utcOffset: number,
  date: string,
): DashboardRow[] {
  const rows: DashboardRow[] = [];

  // Convert autotask items to rows
  for (const at of autotaskItems) {
    const startMs = new Date(at.startDateTime).getTime();
    const endMs = new Date(at.endDateTime).getTime();
    const durationMs = endMs - startMs;

    rows.push({
      source: "autotask",
      startTime: formatLocalTime(at.startDateTime, utcOffset),
      endTime: formatLocalTime(at.endDateTime, utcOffset),
      durationMs,
      durationLabel: formatDuration(durationMs),
      description: at.summaryNotes || "(no notes)",
      isNonBillable: at.isNonBillable,
      isRunning: false,
      atId: at.id,
      ticketID: at.ticketID,
      hoursWorked: at.hoursWorked,
    });
  }

  // Convert local entries to rows (filter for given date)
  const offsetMs = utcOffset * 60 * 60 * 1000;
  for (const le of localEntries) {
    const startDate = new Date(
      new Date(le.started_at).getTime() + offsetMs,
    );
    const startDateStr = startDate.toISOString().slice(0, 10);

    if (startDateStr === date) {
      const endMs = le.stopped_at
        ? new Date(le.stopped_at).getTime()
        : Date.now();
      const durationMs = endMs - new Date(le.started_at).getTime();
      rows.push({
        source: "local",
        startTime: formatLocalTime(le.started_at, utcOffset),
        endTime: le.stopped_at
          ? formatLocalTime(le.stopped_at, utcOffset)
          : "now",
        durationMs,
        durationLabel: formatDuration(durationMs),
        description: `#${le.sequence_id} ${le.title}`,
        isNonBillable: false,
        isRunning: le.stopped_at === null,
        sequenceId: le.sequence_id,
        issueId: le.issue_id,
      });
    }
  }

  // Sort chronologically by start time string
  rows.sort(
    (a, b) => a.startTime.localeCompare(b.startTime),
  );

  return rows;
}

// ── formatting helpers ───────────────────────────────────────────────

function formatLocalTime(iso: string, utcOffset: number): string {
  const d = new Date(iso);
  // Apply offset to get local time
  const offsetMs = utcOffset * 60 * 60 * 1000;
  const local = new Date(d.getTime() + offsetMs);
  const hours = String(local.getUTCHours()).padStart(2, "0");
  const minutes = String(local.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function formatAutotaskForTool(
  items: AutotaskTimeRecord[],
  utcOffset: number,
  date: string,
): string {
  const totalHours = items.reduce((sum, i) => sum + i.hoursWorked, 0);
  const parts: string[] = [
    `### Autotask Time Entries for ${date}`,
    `Total: ${totalHours.toFixed(2)}h (${items.length} entries)`,
    "",
  ];

  for (const item of items) {
    const start = formatLocalTime(item.startDateTime, utcOffset);
    const end = formatLocalTime(item.endDateTime, utcOffset);
    const billableTag = item.isNonBillable ? " [non-billable]" : "";
    const ticketStr = item.ticketID ? ` #T${item.ticketID}` : "";
    parts.push(
      `- ${start} → ${end}  ` +
        `${item.hoursWorked}h${billableTag}${ticketStr} — ${item.summaryNotes || "(no notes)"}`,
    );
  }

  if (items.length === 0) {
    parts.push("(no time entries for this date)");
  }

  return parts.join("\n");
}
