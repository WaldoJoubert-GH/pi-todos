import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { UnifiedIssue, TimeEntry } from "./types.js";
import {
  loadIssues,
  resolvePlaneConfig,
  resolveSentryConfig,
} from "./config.js";
import { formatDuration } from "./plane.js";
import {
  parseIssueId,
  fetchSentryIssue,
  saveSentryDetail,
  upsertSentryUnifiedIssue,
  formatSentrySummary,
} from "./sentry.js";

// ── format unified issues for LLM ────────────────────────────────────

function formatUnifiedForTool(
  issues: UnifiedIssue[],
  lastSynced: string | undefined,
  runningEntry: TimeEntry | null,
): string {
  const planeIssues = issues.filter((i) => i.source === "plane");
  const sentryIssues = issues.filter((i) => i.source === "sentry");

  const parts: string[] = [];

  // Plane section
  if (planeIssues.length > 0) {
    parts.push(`### Active Plane Issues (${planeIssues.length})`);
    if (lastSynced) {
      parts.push(`Last synced: ${lastSynced}`);
    }
    parts.push("");

    for (const issue of planeIssues) {
      parts.push(
        `- **#${issue.sequence_id}** ${issue.title}  ` +
          `State: ${issue.state_name} · Priority: ${issue.priority} · [open](${issue.link})`,
      );
    }
    parts.push("");
  }

  // Sentry section
  if (sentryIssues.length > 0) {
    parts.push(
      `### Pulled Sentry Issues (${sentryIssues.length})`,
    );
    parts.push("");

    for (const issue of sentryIssues) {
      const countStr =
        issue.count != null ? ` · Events: ${issue.count}` : "";
      parts.push(
        `- **#${issue.sentry_id}** ${issue.title}  ` +
          `Level: ${issue.level} · Status: ${issue.sentry_status}${countStr} · [open](${issue.link})`,
      );
    }
    parts.push("");
  }

  if (issues.length === 0) {
    parts.push("### No issues tracked");
    parts.push(
      "Run `/issues` to fetch Plane issues or `/pull-sentry <id>` to pull a Sentry issue.",
    );
  }

  // Running timer
  if (runningEntry) {
    const elapsed = formatDuration(
      Date.now() - new Date(runningEntry.started_at).getTime(),
    );
    parts.push(
      `\u23F1 Currently tracking: #${runningEntry.sequence_id} ${runningEntry.title} (${elapsed})`,
    );
  }

  return parts.join("\n");
}

// ── register tools ───────────────────────────────────────────────────

export function registerTools(
  pi: ExtensionAPI,
  getTimeEntries: () => TimeEntry[],
) {
  // ── get_todos (unified) ────────────────────────────────────────
  pi.registerTool({
    name: "get_todos",
    label: "Get Todos",
    description:
      "Retrieve the current list of active Plane.so todos and pulled Sentry issues for this project from local cache.",
    promptSnippet:
      "Retrieve the current list of active Plane.so todos and Sentry issues for this project",
    promptGuidelines: [
      "Use get_todos when the user asks about their todo list, active issues, sentry errors, or what they need to work on.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const planeConfig = resolvePlaneConfig(ctx.cwd);
      const sentryConfig = resolveSentryConfig(ctx.cwd);

      if (!planeConfig && !sentryConfig) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No project configured. Run `/issues` in an interactive session first to set up Plane and/or Sentry.",
            },
          ],
          details: {},
        };
      }

      const data = loadIssues(ctx.cwd);
      const issues = data.issues ?? [];
      const entries = getTimeEntries();
      const running = entries.find((e) => e.stopped_at === null) ?? null;

      return {
        content: [
          {
            type: "text" as const,
            text: formatUnifiedForTool(issues, data.last_synced, running),
          },
        ],
        details: {
          total: issues.length,
          plane: issues.filter((i) => i.source === "plane").length,
          sentry: issues.filter((i) => i.source === "sentry").length,
        },
      };
    },
  });

  // ── fetch_sentry_issue ────────────────────────────────────────
  pi.registerTool({
    name: "fetch_sentry_issue",
    label: "Fetch Sentry Issue",
    description:
      "Fetch a Sentry issue by ID or URL and return its details (stack trace, breadcrumbs, tags, etc.). The issue is also saved to .dev/sentry/<id>.json and added to the unified issues list.",
    promptSnippet: "Fetch Sentry issue details by ID or URL",
    promptGuidelines: [
      "Use fetch_sentry_issue when the user provides a Sentry issue ID or URL and wants help debugging it.",
      "After calling fetch_sentry_issue, use get_todos to see the updated issue list.",
    ],
    parameters: Type.Object({
      issue_id_or_url: Type.String({
        description:
          "Sentry issue ID (e.g. 123456) or full URL (e.g. https://org.sentry.io/issues/123456/)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = resolveSentryConfig(ctx.cwd);
      if (!config) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Sentry not configured. Run `/pull-sentry` in an interactive session first to set up, or set env vars: SENTRY_AUTH_TOKEN, SENTRY_ORG_SLUG, SENTRY_PROJECT_SLUG.",
            },
          ],
          details: { error: "missing_config" },
        };
      }

      const issueId = parseIssueId(params.issue_id_or_url);
      if (!issueId) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not parse issue ID from: ${params.issue_id_or_url}. Provide a numeric ID or full Sentry issue URL.`,
            },
          ],
          details: { error: "bad_input" },
        };
      }

      const res = await fetchSentryIssue(config, issueId);
      if (!res.ok) {
        return {
          content: [
            { type: "text" as const, text: `Failed: ${res.error}` },
          ],
          details: { error: res.error },
        };
      }

      // Save detail file
      saveSentryDetail(ctx.cwd, issueId, res.result);

      // Upsert into unified issues list
      upsertSentryUnifiedIssue(ctx.cwd, issueId, res.result);

      const summary = formatSentrySummary(res.result);

      return {
        content: [
          {
            type: "text" as const,
            text: `Saved to .dev/sentry/${issueId}.json and added to issues list.\n\n${summary}`,
          },
        ],
        details: {
          saved_to: `.dev/sentry/${issueId}.json`,
          issue_id: issueId,
          title: (
            res.result.issue as Record<string, unknown>
          ).title,
        },
      };
    },
  });
}
