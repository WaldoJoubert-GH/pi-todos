import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { UnifiedIssue, ResolvedSentryConfig } from "./types.js";
import {
  loadSentryToken,
  saveSentryToken,
  loadDevConfig,
  updateSentryConfig,
  sentryDetailPath,
  upsertSentryIssue,
} from "./config.js";

// ── constants ────────────────────────────────────────────────────────

const SENTRY_BASE = "https://sentry.io/api/0";
const SECRETS_FILE = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "secrets",
  "sentry.json",
);

// ── API fetch ────────────────────────────────────────────────────────

async function apiFetch(
  config: ResolvedSentryConfig,
  apiPath: string,
): Promise<
  { ok: true; data: unknown } | { ok: false; error: string }
> {
  const headers = {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
  };
  try {
    const resp = await fetch(`${SENTRY_BASE}${apiPath}`, { headers });
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
      };
    }
    const data = await resp.json();
    return { ok: true, data };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── slim helpers ─────────────────────────────────────────────────────

function slimIssue(raw: Record<string, unknown>): Record<string, unknown> {
  const keep = new Set([
    "id",
    "title",
    "shortId",
    "status",
    "level",
    "firstSeen",
    "lastSeen",
    "count",
    "userCount",
    "culprit",
    "permalink",
    "type",
    "metadata",
    "isUnhandled",
    "project",
  ]);
  const slim: Record<string, unknown> = {};
  for (const k of keep) {
    if (k in raw) slim[k] = raw[k];
  }
  return slim;
}

function slimEvent(raw: Record<string, unknown>): Record<string, unknown> {
  const keepTop = new Set([
    "eventID",
    "id",
    "groupID",
    "dateCreated",
    "dateReceived",
    "platform",
    "message",
    "title",
    "culprit",
    "level",
    "type",
    "tags",
    "user",
    "entries",
    "breadcrumbs",
    "request",
    "contexts",
    "environment",
    "release",
    "dist",
    "sdk",
  ]);
  const slim: Record<string, unknown> = {};
  for (const k of keepTop) {
    if (k in raw) slim[k] = raw[k];
  }

  // keep only exception/message entries
  if (Array.isArray(slim.entries)) {
    slim.entries = (
      slim.entries as Array<Record<string, unknown>>
    ).filter((e) => e.type === "exception" || e.type === "message");
  }

  // strip verbose context data blobs
  const contexts = slim.contexts as Record<string, unknown> | undefined;
  if (contexts) {
    for (const ctxName of Object.keys(contexts)) {
      const ctx = contexts[ctxName];
      if (ctx && typeof ctx === "object") {
        const c = ctx as Record<string, unknown>;
        delete c.data;
        if (ctxName === "trace") {
          contexts[ctxName] = {
            trace_id: c.trace_id,
            span_id: c.span_id,
            op: c.op,
            status: c.status,
          };
        }
      }
    }
  }

  return slim;
}

// ── parse issue ID ───────────────────────────────────────────────────

export function parseIssueId(raw: string): string | null {
  const urlMatch = raw.match(/\/issues\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  if (/^\d+$/.test(raw.trim())) return raw.trim();
  return null;
}

// ── fetch sentry issue ───────────────────────────────────────────────

export async function fetchSentryIssue(
  config: ResolvedSentryConfig,
  issueId: string,
): Promise<
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string }
> {
  // 1. Fetch issue summary
  const issueRes = await apiFetch(
    config,
    `/organizations/${config.org_slug}/issues/${issueId}/`,
  );
  if (!issueRes.ok) return issueRes;
  const issue = slimIssue(issueRes.data as Record<string, unknown>);

  // 2. Fetch latest event summary
  const latestRes = await apiFetch(
    config,
    `/organizations/${config.org_slug}/issues/${issueId}/events/latest/`,
  );
  if (!latestRes.ok) return latestRes;
  const latest = latestRes.data as Record<string, unknown>;

  const eventId = (latest.eventID || latest.id || "") as string;
  let fullEvent: Record<string, unknown> | null = null;

  // 3. Fetch full event detail
  if (eventId) {
    const eventRes = await apiFetch(
      config,
      `/projects/${config.org_slug}/${config.project_slug}/events/${eventId}/json/`,
    );
    if (eventRes.ok) {
      fullEvent = slimEvent(eventRes.data as Record<string, unknown>);
    }
  }

  return {
    ok: true,
    result: {
      fetched_at: new Date().toISOString(),
      issue,
      latest_event_summary: {
        eventID: latest.eventID ?? latest.id,
        dateCreated: latest.dateCreated,
        platform: latest.platform,
        tags: latest.tags,
        user: latest.user,
      },
      full_event: fullEvent,
    },
  };
}

// ── save + upsert ────────────────────────────────────────────────────

export function saveSentryDetail(
  cwd: string,
  issueId: string,
  result: Record<string, unknown>,
): string {
  const filePath = sentryDetailPath(cwd, issueId);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");
  return filePath;
}

export function upsertSentryUnifiedIssue(
  cwd: string,
  issueId: string,
  result: Record<string, unknown>,
): void {
  const issue = result.issue as Record<string, unknown>;
  const entry: UnifiedIssue = {
    source: "sentry",
    sentry_id: issueId,
    title: String(issue.title ?? ""),
    level: String(issue.level ?? "error"),
    sentry_status: String(issue.status ?? "unresolved"),
    count: typeof issue.count === "number" ? issue.count : undefined,
    culprit:
      typeof issue.culprit === "string" ? issue.culprit : undefined,
    link:
      typeof issue.permalink === "string"
        ? issue.permalink
        : `https://sentry.io/organizations/issues/${issueId}/`,
    detail_file: `.dev/sentry/${issueId}.json`,
    updated_at:
      typeof result.fetched_at === "string"
        ? result.fetched_at
        : new Date().toISOString(),
  };
  upsertSentryIssue(cwd, entry);
}

// ── format summary ───────────────────────────────────────────────────

export function formatSentrySummary(
  result: Record<string, unknown>,
): string {
  const issue = result.issue as Record<string, unknown>;
  const latest = result.latest_event_summary as Record<string, unknown>;
  const full = result.full_event as Record<string, unknown> | null;

  const lines: string[] = [];
  lines.push(`**Issue #${issue.id}**: ${issue.title}`);
  lines.push(
    `Status: ${issue.status} | Level: ${issue.level} | Events: ${issue.count}`,
  );
  lines.push(
    `First seen: ${issue.firstSeen} | Last seen: ${issue.lastSeen}`,
  );
  if (issue.culprit) lines.push(`Culprit: ${issue.culprit}`);
  lines.push(`Permalink: ${issue.permalink}`);

  if (latest.tags) {
    const tags = latest.tags as Array<[string, string]>;
    if (tags.length > 0) {
      lines.push(
        `\nTags: ${tags.map((t) => `${t[0]}=${t[1]}`).join(", ")}`,
      );
    }
  }

  // Stack trace summary
  if (full?.entries) {
    for (const entry of full.entries as Array<Record<string, unknown>>) {
      if (entry.type !== "exception") continue;
      const data = entry.data as Record<string, unknown>;
      const values = data?.values as
        | Array<Record<string, unknown>>
        | undefined;
      if (!values) continue;
      for (const exc of values) {
        lines.push(`\n**Exception**: ${exc.type}: ${exc.value}`);
        const stacktrace = exc.stacktrace as
          | Record<string, unknown>
          | undefined;
        const frames = stacktrace?.frames as
          | Array<Record<string, unknown>>
          | undefined;
        if (!frames) continue;
        lines.push("Stack frames:");
        for (const f of frames.slice(-10)) {
          const ctxArr = f.context as
            | Array<[number, string]>
            | undefined;
          const ctxLine =
            ctxArr?.find((c) => c[0] === f.lineNo)?.[1]?.trim() ?? "";
          lines.push(
            `  ${f.filename}:${f.lineNo} in ${f.function}  ${ctxLine}`,
          );
        }
      }
    }
  }

  return lines.join("\n");
}

// ── interactive setup ────────────────────────────────────────────────

export async function ensureSentrySetup(ctx: {
  hasUI: boolean;
  ui: {
    input(p: string): Promise<string | undefined>;
    notify(m: string, t?: string): void;
  };
  cwd: string;
}): Promise<ResolvedSentryConfig | null> {
  if (!ctx.hasUI) {
    console.log(
      "=== /pull-sentry ===\n" +
        "To use in non-interactive mode, set up files:\n" +
        `  1. Save token to ${SECRETS_FILE}:\n` +
        '     { "token": "sntrys_..." }\n' +
        "  2. Create .dev/config.json in the project root:\n" +
        '     { "sentry": { "org_slug": "...", "project_slug": "..." } }\n' +
        "\nOr use env vars: SENTRY_AUTH_TOKEN, SENTRY_ORG_SLUG, SENTRY_PROJECT_SLUG\n",
    );
    return null;
  }

  let token = loadSentryToken();
  if (!token) {
    const input = await ctx.ui.input(
      "Enter your Sentry Auth Token (Settings > Auth Tokens, scopes: event:read, project:read):",
    );
    if (!input || input.trim().length === 0) {
      ctx.ui.notify("No token provided — aborting.", "error");
      return null;
    }
    token = input.trim();
    saveSentryToken(token);
    ctx.ui.notify(
      "Token saved to ~/.pi/agent/secrets/sentry.json",
      "info",
    );
  }

  let project = loadDevConfig(ctx.cwd).sentry;
  if (!project) {
    const orgSlug = await ctx.ui.input(
      "Enter your Sentry organization slug:",
    );
    if (!orgSlug || orgSlug.trim().length === 0) {
      ctx.ui.notify("No org slug — aborting.", "error");
      return null;
    }
    const projectSlug = await ctx.ui.input(
      "Enter your Sentry project slug:",
    );
    if (!projectSlug || projectSlug.trim().length === 0) {
      ctx.ui.notify("No project slug — aborting.", "error");
      return null;
    }
    project = {
      org_slug: orgSlug.trim(),
      project_slug: projectSlug.trim(),
    };
    updateSentryConfig(ctx.cwd, project);
    ctx.ui.notify("Config saved to .dev/config.json", "info");
  }

  return {
    token,
    org_slug: project.org_slug,
    project_slug: project.project_slug,
  };
}
