import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ensureDevDir,
  migrateIfNeeded,
  loadIssues,
  saveIssues,
  resolvePlaneConfig,
  resolveSentryConfig,
  resolveAutotaskConfig,
  loadTimeEntries,
  loadDevConfig,
  updatePlaneConfig,
  readAutotaskCache,
  readLatestCache,
  readActionsCache,
  writeActionsCache,
  readJobsDetail,
  writeJobsDetail,
} from "./src/config.js";
import type { UnifiedIssue, PlaneCache, TimeEntry, PlaneStateItem, GitHubWidgetStatus, GitHubRun, GitHubJob } from "./src/types.js";
import {
  ensurePlaneSetup,
  fetchProjectIdentifier,
  syncPlane,
  SYNC_INTERVAL_MS,
  getRunningEntry,
  getAccumulatedMs,
  startTimeEntry,
  stopRunningEntry,
  formatPlaneForTool,
  formatDuration,
  formatTimestamp,
  getStates,
  patchIssueState,
  loadStatesCache,
  resolveDefaultStateId,
  createIssue,
} from "./src/plane.js";
import {
  ensureSentrySetup,
  parseIssueId,
  fetchSentryIssue,
  saveSentryDetail,
  upsertSentryUnifiedIssue,
  formatSentrySummary,
} from "./src/sentry.js";
import { UnifiedOverlay, TimesOverlay, ActionsOverlay, buildWidgetLines } from "./src/tui.js";
import { registerTools } from "./src/tools.js";
import {
  ensureAutotaskSetup,
  fetchAutotaskTimeEntries,
  syncAutotask,
  buildDashboard,
  getTodayDateString,
  AUTOTASK_SYNC_INTERVAL_MS,
  formatAutotaskForTool,
} from "./src/autotask.js";
import type { ResolvedAutotaskConfig } from "./src/types.js";
import {
  resolveGitHubConfig,
  resolveGitHubRepo,
  loadGitHubToken,
  saveGitHubToken,
  fetchLatestRun,
  fetchActionsRuns,
  fetchRunJobs,
  fetchWidgetStatus,
  ensureGitHubSetup,
  fetchGitHubUser,
  LATEST_SYNC_INTERVAL_MS,
  RUNS_SYNC_INTERVAL_MS,
} from "./src/github.js";
import type { ResolvedGitHubConfig } from "./src/github.js";

// ── extension state ──────────────────────────────────────────────────

let syncTimer: ReturnType<typeof setInterval> | null = null;
let overlayComponent: UnifiedOverlay | null = null;
let overlayHandle: { close: () => void } | null = null;

let timeEntryState: TimeEntry[] = [];
let widgetTimerInterval: ReturnType<typeof setInterval> | null = null;
let lastPlaneCache: PlaneCache | null = null;
let autotaskTotalHours: number | null = null;
let autotaskSyncTimer: ReturnType<typeof setInterval> | null = null;
let autotaskConfigForSync: ResolvedAutotaskConfig | null = null;

// GitHub Actions state
let ghLatestTimer: ReturnType<typeof setInterval> | null = null;
let ghRunsTimer: ReturnType<typeof setInterval> | null = null;
let ghWidgetStatus: GitHubWidgetStatus | null = null;
let ghConfig: ResolvedGitHubConfig | null = null;
let ghActorLogin: string | null = null;
let ghSyncError: string | null = null;

// ── widget timer ─────────────────────────────────────────────────────

function startWidgetTimer(ctx: {
  ui: { setWidget: (name: string, lines: string[]) => void };
  cwd: string;
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

  // Compute daily total: local Time Entries + Autotask hours
  const utcOffset = autotaskConfigForSync?.utcOffset ?? 0;
  const date = getTodayDateString(utcOffset);
  const offsetMs = utcOffset * 60 * 60 * 1000;
  const dailyLocalMs = timeEntryState
    .filter((e) => {
      const d = new Date(e.started_at);
      const local = new Date(d.getTime() + offsetMs);
      return local.toISOString().slice(0, 10) === date;
    })
    .reduce((sum, e) => {
      const startMs = new Date(e.started_at).getTime();
      const endMs = e.stopped_at
        ? new Date(e.stopped_at).getTime()
        : Date.now();
      return sum + (endMs - startMs);
    }, 0);
  const dailyTotalMs =
    dailyLocalMs + (autotaskTotalHours ?? 0) * 3600000;

  const planeCfg = resolvePlaneConfig(ctx.cwd);
  const widgetProjectIdentifier = planeCfg?.project_identifier ?? null;

  ctx.ui.setWidget(
    "todos",
    buildWidgetLines(
      lastPlaneCache,
      sentryCount,
      running,
      missing,
      dailyTotalMs,
      widgetProjectIdentifier,
      ghWidgetStatus,
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

// ── state change handler ──────────────────────────────────────────────

async function handleChangeState(
  ctx: {
    ui: { setWidget: (name: string, lines: string[]) => void; notify: (m: string, t?: string) => void };
    cwd: string;
  },
  issue: UnifiedIssue,
  newStateId: string,
): Promise<void> {
  if (issue.source !== "plane" || !issue.id) return;

  const cfg = resolvePlaneConfig(ctx.cwd);
  if (!cfg) return;

  // Fetch states to resolve the new state's name/hex/group
  const states = await getStates(ctx.cwd, cfg, cfg.token);
  const newState = states.find((s) => s.id === newStateId);
  if (!newState) {
    ctx.ui.notify("Failed to resolve state.", "error");
    return;
  }

  // Call the Plane API
  const ok = await patchIssueState(cfg, cfg.token, issue.id, newStateId);
  if (!ok) {
    ctx.ui.notify("Failed to update issue state on Plane.", "error");
    return;
  }

  // Optimistic local update: update the issue in issues.json
  const issuesFile = loadIssues(ctx.cwd);
  const idx = issuesFile.issues.findIndex(
    (i) => i.source === "plane" && i.id === issue.id,
  );
  const EXCLUDED = new Set(["completed", "cancelled"]);
  if (idx >= 0) {
    if (EXCLUDED.has(newState.group)) {
      // Remove completed/cancelled issues from the unified list
      issuesFile.issues.splice(idx, 1);
    } else {
      issuesFile.issues[idx] = {
        ...issuesFile.issues[idx],
        state_id: newState.id,
        state_name: newState.name,
        state_hex: newState.color,
        state_group: newState.group,
      };
    }
    saveIssues(ctx.cwd, issuesFile);
  }

  // Update lastPlaneCache in-memory
  if (lastPlaneCache) {
    const ci = lastPlaneCache.issues.findIndex(
      (i) => i.id === issue.id,
    );
    if (ci >= 0) {
      const oldIssue = lastPlaneCache.issues[ci];
      const oldGroup = oldIssue.state_group ?? "unknown";
      const oldName = oldIssue.state_name ?? "Unknown";
      const newGroup = newState.group;

      // Update the issue in cache
      lastPlaneCache.issues[ci] = {
        ...oldIssue,
        state_id: newState.id,
        state_name: newState.name,
        state_hex: newState.color,
        state_group: newGroup,
      };

      // Shift state counts
      if (lastPlaneCache.states[oldName]) {
        lastPlaneCache.states[oldName].count = Math.max(
          0,
          lastPlaneCache.states[oldName].count - 1,
        );
      }
      if (!lastPlaneCache.states[newState.name]) {
        lastPlaneCache.states[newState.name] = {
          count: 0,
          color: newState.color,
          group: newGroup,
        };
      }
      lastPlaneCache.states[newState.name].count++;

      // If moved to completed/cancelled, remove from active list
      const EXCLUDED = new Set(["completed", "cancelled"]);
      if (EXCLUDED.has(newGroup)) {
        lastPlaneCache.issues.splice(ci, 1);
        lastPlaneCache.total_active = lastPlaneCache.issues.length;
      }
    }
  }

  // Refresh the widget
  refreshWidget(ctx);

  // Update the overlay if it's open
  if (overlayComponent) {
    const updatedFile = loadIssues(ctx.cwd);
    overlayComponent.updateIssues(updatedFile.issues);
  }
}

// ── create issue handler ────────────────────────────────────────────

async function handleCreateIssue(
  ctx: {
    ui: { setWidget: (name: string, lines: string[]) => void; notify: (m: string, t?: string) => void };
    cwd: string;
  },
  title: string,
): Promise<boolean> {
  if (!title || title.trim().length === 0) return false;

  const planeCfg = resolvePlaneConfig(ctx.cwd);
  if (!planeCfg) {
    ctx.ui.notify("Plane is not configured — cannot create issue.", "error");
    return false;
  }

  // Load states and resolve default state
  const states = await getStates(ctx.cwd, planeCfg, planeCfg.token);
  const defaultStateId = resolveDefaultStateId(states);
  if (!defaultStateId) {
    ctx.ui.notify("No suitable default State found (looked for Todo/unstarted/backlog).", "error");
    return false;
  }

  // Get today's date (ISO 8601) using UTC — Plane expects UTC dates
  const today = new Date().toISOString().slice(0, 10);

  // Call the Plane API
  const result = await createIssue(
    planeCfg,
    planeCfg.token,
    title,
    defaultStateId,
    today,
  );

  if (!result.ok || !result.issue) {
    ctx.ui.notify(
      `Failed to create issue: ${result.error ?? "Unknown error"}`,
      "error",
    );
    return false;
  }

  // Resolve the default state's name/hex/group for the optimistic add
  const defaultState = states.find((s) => s.id === defaultStateId);
  const stateName = defaultState?.name ?? "Todo";
  const stateHex = defaultState?.color ?? "#808080";
  const stateGroup = defaultState?.group ?? "unstarted";

  // Build the full unified issue with resolved state info
  const newIssue: UnifiedIssue = {
    ...result.issue,
    state_name: stateName,
    state_hex: stateHex,
    state_group: stateGroup,
  };

  // Optimistic local add to issues.json
  const issuesFile = loadIssues(ctx.cwd);
  issuesFile.issues.unshift(newIssue);
  saveIssues(ctx.cwd, issuesFile);

  // Optimistic update to lastPlaneCache
  if (lastPlaneCache) {
    lastPlaneCache.issues.unshift(newIssue);
    lastPlaneCache.total_active = lastPlaneCache.issues.length;
    if (!lastPlaneCache.states[stateName]) {
      lastPlaneCache.states[stateName] = {
        count: 0,
        color: stateHex,
        group: stateGroup,
      };
    }
    lastPlaneCache.states[stateName].count++;
  }

  // Refresh the widget
  refreshWidget(ctx);

  // Update the overlay if it's open
  if (overlayComponent) {
    const updatedFile = loadIssues(ctx.cwd);
    overlayComponent.updateIssues(updatedFile.issues);
  }

  // Auto-switch overlay filter from sentry to all so the new issue is visible
  if (overlayComponent) {
    overlayComponent.setFilter("all");
  }

  ctx.ui.notify(`Created issue #${newIssue.sequence_id ?? "?"}`, "info");
  return true;
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

// ── autotask sync ────────────────────────────────────────────────────

let syncingAutotask = false;

async function doAutotaskSync(ctx: {
  ui: { setWidget: (name: string, lines: string[]) => void };
  cwd: string;
}): Promise<void> {
  if (syncingAutotask || !autotaskConfigForSync) return;
  syncingAutotask = true;

  try {
    const date = getTodayDateString(autotaskConfigForSync.utcOffset);
    const cache = await syncAutotask(
      ctx.cwd,
      autotaskConfigForSync,
      date,
    );
    if (cache) {
      autotaskTotalHours = cache.items.reduce(
        (sum, i) => sum + i.hoursWorked,
        0,
      );
      refreshWidget(ctx);
    }
  } finally {
    syncingAutotask = false;
  }
}

function startAutotaskSync(ctx: {
  ui: { setWidget: (name: string, lines: string[]) => void };
  cwd: string;
}): void {
  if (autotaskSyncTimer) return;
  doAutotaskSync(ctx);
  autotaskSyncTimer = setInterval(
    () => doAutotaskSync(ctx),
    AUTOTASK_SYNC_INTERVAL_MS,
  );
}

// ── github actions sync ─────────────────────────────────────────────

let syncingGhLatest = false;

async function doGhLatestSync(ctx: {
  ui: { setWidget: (name: string, lines: string[]) => void };
  cwd: string;
}): Promise<void> {
  if (syncingGhLatest || !ghConfig) return;
  syncingGhLatest = true;

  try {
    const status = await fetchWidgetStatus(ctx.cwd, ghConfig);
    ghWidgetStatus = status;
    refreshWidget(ctx);
  } catch {
    ghWidgetStatus = { run: null, error: "api" };
    refreshWidget(ctx);
  } finally {
    syncingGhLatest = false;
  }
}

function startGhLatestSync(ctx: {
  ui: { setWidget: (name: string, lines: string[]) => void };
  cwd: string;
}): void {
  if (ghLatestTimer) return;
  doGhLatestSync(ctx);
  ghLatestTimer = setInterval(
    () => doGhLatestSync(ctx),
    LATEST_SYNC_INTERVAL_MS,
  );
}

let syncingGhRuns = false;

async function doGhRunsSync(ctx: {
  ui: { setWidget: (name: string, lines: string[]) => void };
  cwd: string;
}): Promise<void> {
  if (syncingGhRuns || !ghConfig) return;
  syncingGhRuns = true;

  try {
    const res = await fetchActionsRuns(ghConfig);
    if (res.ok) {
      writeActionsCache(ctx.cwd, res.cache);
      ghSyncError = null;
    } else {
      ghSyncError = res.error;
    }
  } catch {
    ghSyncError = "GH sync failed";
  } finally {
    syncingGhRuns = false;
  }
}

function startGhRunsSync(ctx: {
  ui: { setWidget: (name: string, lines: string[]) => void };
  cwd: string;
}): void {
  if (ghRunsTimer) return;
  doGhRunsSync(ctx);
  ghRunsTimer = setInterval(
    () => doGhRunsSync(ctx),
    RUNS_SYNC_INTERVAL_MS,
  );
}

// ── overlay display ──────────────────────────────────────────────────

interface TuiHandle {
  requestRender: () => void;
}

async function showOverlay(
  ctx: never,
  issues: UnifiedIssue[],
  projectIdentifier: string | null,
  cwd: string,
  setWidget: (name: string, lines: string[]) => void,
  states: PlaneStateItem[],
  onChangeStateFn: (issue: UnifiedIssue, newStateId: string) => void,
  onCreateFn?: (title: string) => Promise<boolean>,
): Promise<void> {
  const ui = ctx as unknown as {
    ui: {
      custom: (
        factory: (...args: unknown[]) => unknown,
        options?: Record<string, unknown>,
      ) => Promise<null>;
    };
  };

  await ui.ui.custom(
    (
      tui: TuiHandle,
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
        onChangeStateFn,
        onCreateFn,
      );
      component.setStates(states);
      component.requestRender = () => tui.requestRender();
      overlayComponent = component;
      return {
        render: (w: number) => component.render(w),
        invalidate: () => component.invalidate(),
        handleInput: (data: string) => {
          component.handleInput(data);
          component.invalidate();
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
      },
    },
  );

  overlayComponent = null;
  overlayHandle = null;
}

// ── times overlay display ──────────────────────────────────────────

async function showTimesOverlay(
  ctx: never,
  initialRows: import("./src/autotask.js").DashboardRow[],
  initialTotal: number,
  atCfg: ResolvedAutotaskConfig,
  setWidget: (name: string, lines: string[]) => void,
  syncError: string | null,
): Promise<void> {
  const ui = ctx as unknown as {
    ui: {
      custom: (
        factory: (...args: unknown[]) => unknown,
        options?: Record<string, unknown>,
      ) => Promise<null>;
    };
  };

  await ui.ui.custom(
    (
      tui: TuiHandle,
      theme: {
        fg: (color: string, text: string) => string;
        bg: (color: string, text: string) => string;
      },
      _keybindings: unknown,
      done: (result: null) => void,
    ) => {
      const component = new TimesOverlay(
        initialRows,
        initialTotal,
        theme,
        () => done(null),
        atCfg.utcOffset,
        syncError,
      );
      overlayComponent = component as unknown as UnifiedOverlay;
      return {
        render: (w: number) => component.render(w),
        invalidate: () => component.invalidate(),
        handleInput: (data: string) => {
          component.handleInput(data);
          component.invalidate();
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
      },
    },
  );

  overlayComponent = null;
  overlayHandle = null;
}

// ── actions overlay display ────────────────────────────────────────

async function showActionsOverlay(
  ctx: never,
  runs: GitHubRun[],
  ownerRepo: string,
  actorLogin: string | null,
  onFetchJobs: (runId: number) => Promise<GitHubJob[]>,
): Promise<void> {
  const ui = ctx as unknown as {
    ui: {
      custom: (
        factory: (...args: unknown[]) => unknown,
        options?: Record<string, unknown>,
      ) => Promise<null>;
    };
  };

  await ui.ui.custom(
    (
      tui: TuiHandle,
      theme: {
        fg: (color: string, text: string) => string;
        bg: (color: string, text: string) => string;
      },
      _keybindings: unknown,
      done: (result: null) => void,
    ) => {
      const component = new ActionsOverlay(
        runs,
        theme,
        () => done(null),
        actorLogin,
        onFetchJobs,
        ownerRepo,
      );
      component.requestRender = () => tui.requestRender();
      return {
        render: (w: number) => component.render(w),
        invalidate: () => component.invalidate(),
        handleInput: (data: string) => {
          component.handleInput(data);
          component.invalidate();
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
      },
    },
  );
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

    // ── initialize autotask sync ────────────────────────────────
    const atCfg = resolveAutotaskConfig(ctx.cwd);
    if (atCfg) {
      autotaskConfigForSync = atCfg;
      const date = getTodayDateString(atCfg.utcOffset);
      const existing = readAutotaskCache(ctx.cwd, date);
      if (existing) {
        autotaskTotalHours = existing.items.reduce(
          (sum, i) => sum + i.hoursWorked,
          0,
        );
        refreshWidget(ctx);
      }
      startAutotaskSync(ctx);
    }

    // ── initialize github actions ──────────────────────────────
    const ghResolved = resolveGitHubConfig(ctx.cwd);
    if (ghResolved.ok) {
      ghConfig = ghResolved.config;

      // Fetch actor login for "my" filter
      fetchGitHubUser(ghConfig)
        .then((login) => {
          ghActorLogin = login;
        })
        .catch(() => {});

      // Try loading cached latest for widget
      const latestCache = readLatestCache(ctx.cwd);
      if (latestCache && latestCache.owner === ghConfig.owner && latestCache.repo === ghConfig.repo) {
        ghWidgetStatus = { run: latestCache.run ?? null, error: null };
      }

      refreshWidget(ctx);
      startGhLatestSync(ctx);
      startGhRunsSync(ctx);
    }
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
      const stateItems = planeCfg
        ? await getStates(ctx.cwd, planeCfg, planeCfg.token)
        : loadStatesCache(ctx.cwd);
      await showOverlay(
        ctx as never,
        allIssues,
        projectIdentifier,
        ctx.cwd,
        (name, lines) => ctx.ui.setWidget(name, lines),
        stateItems,
        (issue, newStateId) => {
          handleChangeState(ctx, issue, newStateId);
        },
        (title: string) =>
          handleCreateIssue(ctx, title),
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
      const stateItems = await getStates(
        ctx.cwd,
        setup.config,
        setup.token,
      );
      await showOverlay(
        ctx as never,
        allIssues,
        setup.config.project_identifier ?? null,
        ctx.cwd,
        (name, lines) => ctx.ui.setWidget(name, lines),
        stateItems,
        (issue, newStateId) => {
          handleChangeState(ctx, issue, newStateId);
        },
        (title: string) =>
          handleCreateIssue(ctx, title),
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

  // ── command: /times ─────────────────────────────────────────
  pi.registerCommand("times", {
    description:
      "Show today's time entries from Autotask and local tracking",
    handler: async (_args: string, ctx) => {
      // Resolve or set up autotask config
      const atCfg = await ensureAutotaskSetup(ctx);
      if (!atCfg) return;

      if (!ctx.hasUI) {
        // Non-interactive: fetch and print
        const date = getTodayDateString(atCfg.utcOffset);
        const { items, error } = await fetchAutotaskTimeEntries(atCfg, date);
        if (error) {
          console.log(`Autotask API error: ${error}`);
        } else {
          console.log(formatAutotaskForTool(items, atCfg.utcOffset, date));
        }

        // Also show local time entries for today
        const localToday = timeEntryState.filter((e) => {
          const d = new Date(e.started_at);
          const offsetMs = atCfg.utcOffset * 60 * 60 * 1000;
          const local = new Date(d.getTime() + offsetMs);
          return local.toISOString().slice(0, 10) === date;
        });
        if (localToday.length > 0) {
          console.log(`\n### Local Time Entries for ${date} (${localToday.length})\n`);
          for (const le of localToday) {
            const running = le.stopped_at === null;
            const startMs = new Date(le.started_at).getTime();
            const endMs = le.stopped_at
              ? new Date(le.stopped_at).getTime()
              : Date.now();
            const dur = formatDuration(endMs - startMs);
            const status = running ? " [running]" : "";
            console.log(
              `- #${le.sequence_id} ${le.title}  ${formatTimestamp(le.started_at)} → ${le.stopped_at ? formatTimestamp(le.stopped_at) : "now"}  ${dur}${status}`,
            );
          }
        }
        return;
      }

      // Interactive mode: show overlay
      const date = getTodayDateString(atCfg.utcOffset);

      // Start autotask background sync if not running
      if (!autotaskSyncTimer) {
        autotaskConfigForSync = atCfg;
        startAutotaskSync(ctx);
      }

      // Fetch current data
      const cache = await syncAutotask(ctx.cwd, atCfg, date);
      let autotaskItems = cache?.items ?? [];
      let syncError: string | null = null;

      if (!cache) {
        // Try reading existing cache as fallback
        const existing = readAutotaskCache(ctx.cwd, date);
        if (existing) {
          autotaskItems = existing.items;
          syncError = "Using cached data — API refresh failed";
        } else {
          syncError = "Failed to fetch Autotask data";
        }
      }

      // Update total hours for widget
      autotaskTotalHours = autotaskItems.reduce(
        (sum, i) => sum + i.hoursWorked,
        0,
      );
      refreshWidget(ctx);

      // Build initial dashboard
      const rows = buildDashboard(
        autotaskItems,
        timeEntryState,
        atCfg.utcOffset,
        date,
      );
      const totalHours = rows.reduce(
        (sum, r) =>
          sum + (r.hoursWorked ?? r.durationMs / 3600000),
        0,
      );

      // Show overlay with date-change handler
      await showTimesOverlay(
        ctx as never,
        rows,
        totalHours,
        atCfg,
        (name, lines) => ctx.ui.setWidget(name, lines),
        syncError,
      );
    },
  });

  // ── command: /actions ────────────────────────────────────────
  pi.registerCommand("actions", {
    description:
      "Show GitHub Actions workflow runs for the current repo",
    handler: async (_args: string, ctx) => {
      if (!ctx.hasUI) {
        // Non-interactive mode
        const ghResolved = resolveGitHubConfig(ctx.cwd);
        if (!ghResolved.ok) {
          console.log(
            `GitHub Actions not configured: ${ghResolved.reason}. Run /actions interactively to set up.`,
          );
          return;
        }

        const result = await fetchActionsRuns(ghResolved.config);
        if (!result.ok) {
          console.log(`GitHub API error: ${result.error}`);
          return;
        }

        console.log(`### GitHub Actions — ${ghResolved.config.owner}/${ghResolved.config.repo}`);
        console.log(`Total runs: ${result.cache.total_count} (showing ${result.cache.runs.length})\n`);
        for (const run of result.cache.runs) {
          const conclusion =
            run.status === "completed"
              ? run.conclusion ?? "?"
              : run.status ?? "?";
          console.log(
            `- #${run.run_number} ${run.name || run.display_title}  ` +
              `Branch: ${run.head_branch ?? "?"}  ` +
              `Event: ${run.event}  ` +
              `${conclusion}  ` +
              `[${run.html_url}]`,
          );
        }
        return;
      }

      // Interactive mode
      let resolved = resolveGitHubConfig(ctx.cwd);
      if (!resolved.ok) {
        // Try interactive setup
        const setupResult = await ensureGitHubSetup(ctx);
        if (!setupResult) return;
        resolved = { ok: true, config: setupResult };

        // Start GH sync now that we're configured
        ghConfig = setupResult;
        fetchGitHubUser(ghConfig)
          .then((login) => {
            ghActorLogin = login;
          })
          .catch(() => {});
        startGhLatestSync(ctx);
        startGhRunsSync(ctx);
      }

      // Fetch runs
      ctx.ui.notify("Fetching workflow runs…", "info");

      // Try cached first
      const cached = readActionsCache(ctx.cwd);
      let runs: GitHubRun[] = [];

      if (
        cached &&
        cached.owner === resolved.config.owner &&
        cached.repo === resolved.config.repo
      ) {
        runs = cached.runs;
      }

      if (runs.length === 0) {
        const result = await fetchActionsRuns(resolved.config);
        if (result.ok) {
          runs = result.cache.runs;
          writeActionsCache(ctx.cwd, result.cache);
        } else {
          ctx.ui.notify(
            `Failed to fetch runs: ${result.error}`,
            "error",
          );
          return;
        }
      }

      const ownerRepo = `${resolved.config.owner}/${resolved.config.repo}`;

      await showActionsOverlay(
        ctx as never,
        runs,
        ownerRepo,
        ghActorLogin,
        async (runId: number): Promise<GitHubJob[]> => {
          // Check cache first
          const cachedJobs = readJobsDetail(ctx.cwd, runId);
          if (cachedJobs) {
            const age =
              Date.now() - new Date(cachedJobs.fetched_at).getTime();
            if (age < 5 * 60_000) {
              // Cache valid for 5 min
              return cachedJobs.jobs;
            }
          }

          const res = await fetchRunJobs(resolved.config!, runId);
          if (res.ok) {
            writeJobsDetail(ctx.cwd, res.detail);
            return res.detail.jobs;
          }
          return [];
        },
      );
    },
  });

  // ── cleanup ──────────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    if (autotaskSyncTimer) {
      clearInterval(autotaskSyncTimer);
      autotaskSyncTimer = null;
    }
    if (ghLatestTimer) {
      clearInterval(ghLatestTimer);
      ghLatestTimer = null;
    }
    if (ghRunsTimer) {
      clearInterval(ghRunsTimer);
      ghRunsTimer = null;
    }
    stopWidgetTimer();
    overlayComponent = null;
    overlayHandle = null;
  });
}
