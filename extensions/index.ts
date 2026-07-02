import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ensureDevDir,
  migrateIfNeeded,
  loadIssues,
  resolvePlaneConfig,
  resolveSentryConfig,
  loadTimeEntries,
  loadDevConfig,
  updatePlaneConfig,
} from "./src/config.js";
import type { UnifiedIssue, PlaneCache, TimeEntry } from "./src/types.js";
import {
  ensurePlaneSetup,
  fetchProjectIdentifier,
  syncPlane,
  SYNC_INTERVAL_MS,
  getRunningEntry,
  getAccumulatedMs,
  startTimeEntry,
  stopRunningEntry,
  checkForUpdate,
  getCurrentVersionPublic,
  getPackageRepoUrlPublic,
  formatPlaneForTool,
} from "./src/plane.js";
import {
  ensureSentrySetup,
  parseIssueId,
  fetchSentryIssue,
  saveSentryDetail,
  upsertSentryUnifiedIssue,
  formatSentrySummary,
} from "./src/sentry.js";
import { UnifiedOverlay, buildWidgetLines } from "./src/tui.js";
import { registerTools } from "./src/tools.js";

// ── extension state ──────────────────────────────────────────────────

let syncTimer: ReturnType<typeof setInterval> | null = null;
let overlayComponent: UnifiedOverlay | null = null;
let overlayHandle: { close: () => void } | null = null;

let timeEntryState: TimeEntry[] = [];
let widgetTimerInterval: ReturnType<typeof setInterval> | null = null;
let lastPlaneCache: PlaneCache | null = null;
let updateAvailableVersion: string | null = null;

// ── widget timer ─────────────────────────────────────────────────────

function startWidgetTimer(ctx: {
  ui: { setWidget: (name: string, lines: string[]) => void };
}): void {
  if (widgetTimerInterval) return;
  widgetTimerInterval = setInterval(() => {
    refreshWidget(ctx);
  }, 1000);
}

function stopWidgetTimer(): void {
  if (widgetTimerInterval) {
    clearInterval(widgetTimerInterval);
    widgetTimerInterval = null;
  }
}

function refreshWidget(ctx: {
  ui: { setWidget: (name: string, lines: string[]) => void };
  cwd: string;
}): void {
  const running = getRunningEntry(timeEntryState);
  const issues = loadIssues(ctx.cwd);
  const sentryCount = issues.issues.filter(
    (i) => i.source === "sentry",
  ).length;
  const missing =
    running !== null &&
    !issues.issues.some(
      (i) => i.source === "plane" && i.id === running.issue_id,
    );
  ctx.ui.setWidget(
    "todos",
    buildWidgetLines(
      lastPlaneCache,
      sentryCount,
      running,
      missing,
      updateAvailableVersion,
      getPackageRepoUrlPublic(),
    ),
  );
}

// ── time toggle handler ──────────────────────────────────────────────

function handleToggleTime(
  ctx: {
    ui: { setWidget: (name: string, lines: string[]) => void };
    cwd: string;
  },
  issue: UnifiedIssue,
): void {
  if (issue.source !== "plane") return;

  const running = getRunningEntry(timeEntryState);
  if (running && running.issue_id === issue.id) {
    stopRunningEntry(timeEntryState, ctx.cwd);
    stopWidgetTimer();
  } else {
    startTimeEntry(timeEntryState, issue, ctx.cwd);
    startWidgetTimer(ctx);
  }
  refreshWidget(ctx);
}

// ── sync management ──────────────────────────────────────────────────

let syncing = false;

async function doSync(ctx: {
  ui: { setWidget: (name: string, lines: string[]) => void };
  cwd: string;
}): Promise<void> {
  if (syncing) return;
  syncing = true;

  try {
    const cfg = resolvePlaneConfig(ctx.cwd);
    if (!cfg) {
      syncing = false;
      return;
    }

    const cache = await syncPlane(
      ctx.cwd,
      {
        workspace_slug: cfg.workspace_slug,
        project_id: cfg.project_id,
        project_identifier: cfg.project_identifier,
      },
      cfg.token,
    );

    if (cache) {
      lastPlaneCache = cache;
      refreshWidget(ctx);
    } else {
      // Keep stale cache, mark error
      if (lastPlaneCache) {
        lastPlaneCache.sync_error = true;
      }
      refreshWidget(ctx);
    }
  } finally {
    syncing = false;
  }
}

function startSync(ctx: {
  ui: { setWidget: (name: string, lines: string[]) => void };
  cwd: string;
}): void {
  if (syncTimer) return;
  doSync(ctx);
  syncTimer = setInterval(() => doSync(ctx), SYNC_INTERVAL_MS);
}

// ── overlay display ──────────────────────────────────────────────────

async function showOverlay(
  ctx: never,
  issues: UnifiedIssue[],
  projectIdentifier: string | null,
  cwd: string,
  setWidget: (name: string, lines: string[]) => void,
): Promise<void> {
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
      const component = new UnifiedOverlay(
        issues,
        theme,
        () => done(null),
        projectIdentifier,
        (issue: UnifiedIssue) => {
          handleToggleTime({ ui: { setWidget }, cwd }, issue);
        },
        () => getRunningEntry(timeEntryState)?.issue_id ?? null,
        (issueId: string) =>
          getAccumulatedMs(timeEntryState, issueId),
        (issueId: string) =>
          timeEntryState.filter((e) => e.issue_id === issueId),
        cwd,
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

  overlayComponent = null;
  overlayHandle = null;
}

// ── extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── migrate on load ──────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Ensure .dev/ exists and migrate old data
    ensureDevDir(ctx.cwd);
    const migrated = migrateIfNeeded(ctx.cwd);
    if (migrated && ctx.hasUI) {
      ctx.ui.notify(
        "Migrated old data to .dev/ directory.",
        "info",
      );
    }

    if (!ctx.hasUI) return;

    // Load time entries
    timeEntryState = loadTimeEntries(ctx.cwd);

    // Try loading existing issues
    const issues = loadIssues(ctx.cwd);
    const issuesList = issues.issues ?? [];

    // Try plane sync if configured
    const planeCfg = resolvePlaneConfig(ctx.cwd);
    if (planeCfg) {
      // Fetch project identifier if missing
      if (!planeCfg.project_identifier) {
        const identifier = await fetchProjectIdentifier(
          {
            workspace_slug: planeCfg.workspace_slug,
            project_id: planeCfg.project_id,
          },
          planeCfg.token,
        );
        if (identifier) {
          updatePlaneConfig(ctx.cwd, {
            ...loadDevConfig(ctx.cwd).plane!,
            project_identifier: identifier,
          });
        }
      }

      // Load cached state for widget
      const planeIssues = issuesList.filter(
        (i) => i.source === "plane",
      );
      if (planeIssues.length > 0) {
        // Rebuild PlaneCache-like structure for widget
        const statesAcc: Record<
          string,
          { count: number; color: string; group: string }
        > = {};
        for (const iss of planeIssues) {
          const name = iss.state_name ?? "Unknown";
          if (!statesAcc[name]) {
            statesAcc[name] = {
              count: 0,
              color: iss.state_hex ?? "#808080",
              group: iss.state_group ?? "unknown",
            };
          }
          statesAcc[name].count++;
        }
        lastPlaneCache = {
          last_synced: issues.last_synced ?? "",
          workspace_slug: planeCfg.workspace_slug,
          project_id: planeCfg.project_id,
          issues: planeIssues,
          states: statesAcc,
          total_active: planeIssues.length,
        };
      }

      // Show widget if we have data
      refreshWidget(ctx);

      // Resume widget timer if a running entry exists
      if (getRunningEntry(timeEntryState)) {
        startWidgetTimer(ctx);
      }

      // Start background sync
      startSync(ctx);
    } else {
      // No plane config — just show what we have
      refreshWidget(ctx);
    }

    // Check for updates
    checkForUpdate().then((newVersion) => {
      if (newVersion) {
        updateAvailableVersion = newVersion;
        const current = getCurrentVersionPublic();
        const repoUrl = getPackageRepoUrlPublic();
        const installCmd = repoUrl
          ? `pi install ${repoUrl}@${newVersion}`
          : `pi install git:github.com/WaldoJoubert-GH/pi-todos@${newVersion}`;
        ctx.ui.notify(
          `pi-todos ${newVersion} available (current: ${current}). Run: ${installCmd}`,
          "info",
        );
        refreshWidget(ctx);
      }
    });
  });

  // ── register tools ────────────────────────────────────────────
  registerTools(pi, () => timeEntryState);

  // ── command: /issues (primary) ────────────────────────────────
  pi.registerCommand("issues", {
    description:
      "List active Plane.so todos and pulled Sentry issues",
    handler: async (_args: string, ctx) => {
      if (!ctx.hasUI) {
        // Non-interactive mode — try Plane, fall back to cached data
        const planeCfg = resolvePlaneConfig(ctx.cwd);

        if (planeCfg) {
          if (!planeCfg.project_identifier) {
            const identifier = await fetchProjectIdentifier(
              {
                workspace_slug: planeCfg.workspace_slug,
                project_id: planeCfg.project_id,
              },
              planeCfg.token,
            );
            if (identifier) {
              updatePlaneConfig(ctx.cwd, {
                ...loadDevConfig(ctx.cwd).plane!,
                project_identifier: identifier,
              });
            }
          }

          const cache = await syncPlane(
            ctx.cwd,
            {
              workspace_slug: planeCfg.workspace_slug,
              project_id: planeCfg.project_id,
              project_identifier: planeCfg.project_identifier,
            },
            planeCfg.token,
          );
          if (cache) {
            lastPlaneCache = cache;
          }
        }

        // Print the unified list
        const issues = loadIssues(ctx.cwd);
        const planeIssues = issues.issues.filter(
          (i) => i.source === "plane",
        );
        const sentryIssues = issues.issues.filter(
          (i) => i.source === "sentry",
        );

        if (planeIssues.length > 0) {
          console.log(
            formatPlaneForTool({
              last_synced: issues.last_synced ?? "",
              workspace_slug: planeCfg?.workspace_slug ?? "",
              project_id: planeCfg?.project_id ?? "",
              issues: planeIssues,
              states: {},
              total_active: planeIssues.length,
            }),
          );
        }

        if (sentryIssues.length > 0) {
          console.log(
            `\n### Pulled Sentry Issues (${sentryIssues.length})\n`,
          );
          for (const iss of sentryIssues) {
            console.log(
              `- **#${iss.sentry_id}** ${iss.title}  Level: ${iss.level} · Status: ${iss.sentry_status}`,
            );
          }
        }

        if (planeIssues.length === 0 && sentryIssues.length === 0) {
          console.log(
            "No issues tracked. Run `/issues` interactively to set up Plane, or `/pull-sentry <id>` to pull a Sentry issue.",
          );
        }
        return;
      }

      // Interactive mode — gracefully handle missing Plane config
      let planeCfg = resolvePlaneConfig(ctx.cwd);
      const sentryCfg = resolveSentryConfig(ctx.cwd);

      // If neither is configured, prompt for Plane setup
      if (!planeCfg && !sentryCfg) {
        const setup = await ensurePlaneSetup(ctx);
        if (!setup) return;
        planeCfg = {
          token: setup.token,
          workspace_slug: setup.config.workspace_slug,
          project_id: setup.config.project_id,
          project_identifier: setup.config.project_identifier,
        };
      }

      let projectIdentifier: string | null = null;

      // If Plane is configured, ensure fresh data and start sync
      if (planeCfg) {
        if (!planeCfg.project_identifier) {
          const identifier = await fetchProjectIdentifier(
            {
              workspace_slug: planeCfg.workspace_slug,
              project_id: planeCfg.project_id,
            },
            planeCfg.token,
          );
          if (identifier) {
            updatePlaneConfig(ctx.cwd, {
              ...loadDevConfig(ctx.cwd).plane!,
              project_identifier: identifier,
            });
            planeCfg.project_identifier = identifier;
          }
        }
        projectIdentifier = planeCfg.project_identifier ?? null;

        const issuesFile = loadIssues(ctx.cwd);
        const planeIssues = issuesFile.issues.filter(
          (i) => i.source === "plane",
        );

        if (planeIssues.length === 0) {
          ctx.ui.notify("Fetching todos from Plane…", "info");
          const cache = await syncPlane(
            ctx.cwd,
            {
              workspace_slug: planeCfg.workspace_slug,
              project_id: planeCfg.project_id,
              project_identifier: planeCfg.project_identifier,
            },
            planeCfg.token,
          );
          if (cache) {
            lastPlaneCache = cache;
          }
        }

        refreshWidget(ctx);

        if (syncTimer === null) {
          startSync(ctx);
        } else {
          doSync(ctx);
        }
      } else {
        // Only Sentry configured — show what we have
        refreshWidget(ctx);
      }

      // Show overlay with all issues
      const allIssues = loadIssues(ctx.cwd).issues;
      await showOverlay(
        ctx as never,
        allIssues,
        projectIdentifier,
        ctx.cwd,
        (name, lines) => ctx.ui.setWidget(name, lines),
      );
    },
  });

  // ── command: /todos (backward-compat alias) ───────────────────
  pi.registerCommand("todos", {
    description:
      "List active Plane.so todos (alias for /issues)",
    handler: async (_args: string, ctx) => {
      // Delegate to /issues handler by re-running setup + display
      if (!ctx.hasUI) {
        const setup = await ensurePlaneSetup(ctx);
        if (!setup) return;

        if (!setup.config.project_identifier) {
          const identifier = await fetchProjectIdentifier(
            setup.config,
            setup.token,
          );
          if (identifier) {
            setup.config.project_identifier = identifier;
            updatePlaneConfig(ctx.cwd, setup.config);
          }
        }

        const cache = await syncPlane(
          ctx.cwd,
          setup.config,
          setup.token,
        );
        if (cache) {
          lastPlaneCache = cache;
          refreshWidget(ctx);
          console.log(formatPlaneForTool(cache));
        }
        return;
      }

      const setup = await ensurePlaneSetup(ctx);
      if (!setup) return;

      if (!setup.config.project_identifier) {
        const identifier = await fetchProjectIdentifier(
          setup.config,
          setup.token,
        );
        if (identifier) {
          setup.config.project_identifier = identifier;
          updatePlaneConfig(ctx.cwd, setup.config);
        }
      }

      const issuesFile = loadIssues(ctx.cwd);
      let planeIssues = issuesFile.issues.filter(
        (i) => i.source === "plane",
      );

      if (planeIssues.length === 0) {
        ctx.ui.notify("Fetching todos from Plane…", "info");
        const cache = await syncPlane(
          ctx.cwd,
          setup.config,
          setup.token,
        );
        if (cache) {
          lastPlaneCache = cache;
          planeIssues = cache.issues;
        }
      }

      refreshWidget(ctx);

      if (syncTimer === null) {
        startSync(ctx);
      } else {
        doSync(ctx);
      }

      const allIssues = loadIssues(ctx.cwd).issues;
      await showOverlay(
        ctx as never,
        allIssues,
        setup.config.project_identifier ?? null,
        ctx.cwd,
        (name, lines) => ctx.ui.setWidget(name, lines),
      );
    },
  });

  // ── command: /pull-sentry ─────────────────────────────────────
  pi.registerCommand("pull-sentry", {
    description:
      "Fetch a Sentry issue and save to .dev/sentry/<id>.json",
    handler: async (args: string, ctx) => {
      const config =
        resolveSentryConfig(ctx.cwd) ??
        (await ensureSentrySetup(ctx));
      if (!config) return;

      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          "Usage: /pull-sentry <issue_id_or_url>",
          "error",
        );
        return;
      }

      const issueId = parseIssueId(trimmed);
      if (!issueId) {
        ctx.ui.notify(
          `Could not parse issue ID from: ${trimmed}`,
          "error",
        );
        return;
      }

      ctx.ui.notify(
        `Fetching Sentry issue #${issueId}...`,
        "info",
      );

      const res = await fetchSentryIssue(config, issueId);
      if (!res.ok) {
        ctx.ui.notify(
          `Failed to fetch issue: ${res.error}`,
          "error",
        );
        return;
      }

      saveSentryDetail(ctx.cwd, issueId, res.result);
      upsertSentryUnifiedIssue(ctx.cwd, issueId, res.result);

      const summary = formatSentrySummary(res.result);
      ctx.ui.notify(
        `Saved to .dev/sentry/${issueId}.json and added to issues list`,
        "info",
      );
      console.log("\n" + summary + "\n");

      // Refresh widget to update sentry count
      refreshWidget(ctx);
    },
  });

  // ── cleanup ──────────────────────────────────────────────────
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
