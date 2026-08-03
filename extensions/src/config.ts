import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  DevConfig,
  IssuesFile,
  TimeEntry,
  TimeEntryStore,
  ResolvedPlaneConfig,
  ResolvedSentryConfig,
  AutotaskCache,
  ResolvedAutotaskConfig,
  PlaneStatesCache,
  GitHubLatestCache,
  GitHubActionsCache,
  GitHubJobsDetail,
} from "./types.js";

// ── secrets ─────────────────────────────────────────────────────────

const HOME_SECRETS = path.join(os.homedir(), ".pi", "agent", "secrets");
const PLANE_SECRETS_FILE = path.join(HOME_SECRETS, "plane.json");
const SENTRY_SECRETS_FILE = path.join(HOME_SECRETS, "sentry.json");
const AUTOTASK_SECRETS_FILE = path.join(HOME_SECRETS, "autotask.json");

export function loadPlaneToken(): string | null {
  try {
    const raw = fs.readFileSync(PLANE_SECRETS_FILE, "utf-8");
    const data = JSON.parse(raw);
    return typeof data.token === "string" && data.token.length > 0
      ? data.token
      : null;
  } catch {
    return null;
  }
}

export function savePlaneToken(token: string): void {
  fs.mkdirSync(path.dirname(PLANE_SECRETS_FILE), { recursive: true });
  fs.writeFileSync(PLANE_SECRETS_FILE, JSON.stringify({ token }, null, 2), "utf-8");
}

export function loadSentryToken(): string | null {
  try {
    const raw = fs.readFileSync(SENTRY_SECRETS_FILE, "utf-8");
    const data = JSON.parse(raw);
    return typeof data.token === "string" && data.token.length > 0
      ? data.token
      : null;
  } catch {
    return null;
  }
}

export function saveSentryToken(token: string): void {
  fs.mkdirSync(path.dirname(SENTRY_SECRETS_FILE), { recursive: true });
  fs.writeFileSync(SENTRY_SECRETS_FILE, JSON.stringify({ token }, null, 2), "utf-8");
}

export function loadAutotaskSecrets(): { integrationCode: string; username: string; secret: string } | null {
  try {
    const raw = fs.readFileSync(AUTOTASK_SECRETS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (
      typeof data.integrationCode === "string" && data.integrationCode.length > 0 &&
      typeof data.username === "string" && data.username.length > 0 &&
      typeof data.secret === "string" && data.secret.length > 0
    ) {
      return {
        integrationCode: data.integrationCode,
        username: data.username,
        secret: data.secret,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveAutotaskSecrets(integrationCode: string, username: string, secret: string): void {
  fs.mkdirSync(path.dirname(AUTOTASK_SECRETS_FILE), { recursive: true });
  fs.writeFileSync(
    AUTOTASK_SECRETS_FILE,
    JSON.stringify({ integrationCode, username, secret }, null, 2),
    "utf-8",
  );
}

// ── .dev/ directory helpers ─────────────────────────────────────────

export function devDir(cwd: string): string {
  return path.join(cwd, ".dev");
}

export function ensureDevDir(cwd: string): string {
  const dir = devDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "*\n", "utf-8");
  return dir;
}

export function issuesPath(cwd: string): string {
  return path.join(devDir(cwd), "issues.json");
}

export function timeEntriesPath(cwd: string): string {
  return path.join(devDir(cwd), "time-entries.json");
}

export function sentryDir(cwd: string): string {
  const dir = path.join(devDir(cwd), "sentry");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sentryDetailPath(cwd: string, id: string): string {
  return path.join(sentryDir(cwd), `${id}.json`);
}

// ── dev config ─────────────────────────────────────────────────────

export function loadDevConfig(cwd: string): DevConfig {
  try {
    const raw = fs.readFileSync(
      path.join(devDir(cwd), "config.json"),
      "utf-8",
    );
    return JSON.parse(raw) as DevConfig;
  } catch {
    return {};
  }
}

export function saveDevConfig(cwd: string, cfg: DevConfig): void {
  ensureDevDir(cwd);
  fs.writeFileSync(
    path.join(devDir(cwd), "config.json"),
    JSON.stringify(cfg, null, 2),
    "utf-8",
  );
}

export function updatePlaneConfig(
  cwd: string,
  plane: NonNullable<DevConfig["plane"]>,
): void {
  const cfg = loadDevConfig(cwd);
  cfg.plane = plane;
  saveDevConfig(cwd, cfg);
}

export function updateSentryConfig(
  cwd: string,
  sentry: NonNullable<DevConfig["sentry"]>,
): void {
  const cfg = loadDevConfig(cwd);
  cfg.sentry = sentry;
  saveDevConfig(cwd, cfg);
}

export function updateAutotaskConfig(
  cwd: string,
  autotask: NonNullable<DevConfig["autotask"]>,
): void {
  const cfg = loadDevConfig(cwd);
  cfg.autotask = autotask;
  saveDevConfig(cwd, cfg);
}

// ── resolve runtime configs ─────────────────────────────────────────

export function resolvePlaneConfig(cwd: string): ResolvedPlaneConfig | null {
  const token = loadPlaneToken();
  const cfg = loadDevConfig(cwd);
  if (!token || !cfg.plane) return null;
  return {
    token,
    workspace_slug: cfg.plane.workspace_slug,
    project_id: cfg.plane.project_id,
    project_identifier: cfg.plane.project_identifier,
  };
}

export function resolveAutotaskConfig(cwd: string): ResolvedAutotaskConfig | null {
  const secrets = loadAutotaskSecrets();
  const cfg = loadDevConfig(cwd);
  if (!secrets || !cfg.autotask) return null;
  const utcOffset = cfg.autotask.utcOffset ?? -new Date().getTimezoneOffset() / 60;
  return {
    integrationCode: secrets.integrationCode,
    username: secrets.username,
    secret: secrets.secret,
    resourceId: cfg.autotask.resourceId,
    apiBaseUrl: cfg.autotask.apiBaseUrl ?? "https://webservices16.autotask.net",
    utcOffset,
  };
}

// ── autotask cache ─────────────────────────────────────────────────

export function autotaskDir(cwd: string): string {
  const dir = path.join(devDir(cwd), "autotask");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function autotaskCachePath(cwd: string, date: string): string {
  return path.join(autotaskDir(cwd), `${date}.json`);
}

export function readAutotaskCache(cwd: string, date: string): AutotaskCache | null {
  try {
    const raw = fs.readFileSync(autotaskCachePath(cwd, date), "utf-8");
    return JSON.parse(raw) as AutotaskCache;
  } catch {
    return null;
  }
}

export function writeAutotaskCache(cwd: string, cache: AutotaskCache): void {
  ensureDevDir(cwd);
  fs.writeFileSync(autotaskCachePath(cwd, cache.date), JSON.stringify(cache, null, 2), "utf-8");
}

export function resolveSentryConfig(cwd: string): ResolvedSentryConfig | null {
  const token = loadSentryToken();
  const cfg = loadDevConfig(cwd);
  if (token && cfg.sentry) {
    return {
      token,
      org_slug: cfg.sentry.org_slug,
      project_slug: cfg.sentry.project_slug,
    };
  }
  // Fallback to env vars
  const envToken = process.env.SENTRY_AUTH_TOKEN;
  const envOrg = process.env.SENTRY_ORG_SLUG;
  const envProject = process.env.SENTRY_PROJECT_SLUG;
  if (envToken && envOrg && envProject) {
    return {
      token: envToken,
      org_slug: envOrg,
      project_slug: envProject,
    };
  }
  return null;
}

// ── issues file ────────────────────────────────────────────────────

export function loadIssues(cwd: string): IssuesFile {
  try {
    const raw = fs.readFileSync(issuesPath(cwd), "utf-8");
    return JSON.parse(raw) as IssuesFile;
  } catch {
    return { issues: [] };
  }
}

export function saveIssues(cwd: string, data: IssuesFile): void {
  ensureDevDir(cwd);
  fs.writeFileSync(issuesPath(cwd), JSON.stringify(data, null, 2), "utf-8");
}

export function replacePlaneIssues(
  cwd: string,
  planeIssues: IssuesFile["issues"],
  lastSynced: string,
): void {
  const current = loadIssues(cwd);
  const sentryIssues = current.issues.filter((i) => i.source === "sentry");
  saveIssues(cwd, {
    last_synced: lastSynced,
    issues: [...planeIssues, ...sentryIssues],
  });
}

export function upsertSentryIssue(
  cwd: string,
  issue: IssuesFile["issues"][0],
): void {
  const current = loadIssues(cwd);
  const idx = current.issues.findIndex(
    (i) => i.source === "sentry" && i.sentry_id === issue.sentry_id,
  );
  if (idx >= 0) {
    current.issues[idx] = issue;
  } else {
    current.issues.push(issue);
  }
  saveIssues(cwd, current);
}

// ── time entries ────────────────────────────────────────────────────

export function loadTimeEntries(cwd: string): TimeEntry[] {
  try {
    const raw = fs.readFileSync(timeEntriesPath(cwd), "utf-8");
    const store = JSON.parse(raw) as TimeEntryStore;
    return Array.isArray(store.entries) ? store.entries : [];
  } catch {
    return [];
  }
}

export function saveTimeEntries(cwd: string, entries: TimeEntry[]): void {
  ensureDevDir(cwd);
  fs.writeFileSync(
    timeEntriesPath(cwd),
    JSON.stringify({ entries }, null, 2),
    "utf-8",
  );
}

// ── plane states cache ─────────────────────────────────────────────

export function planeStatesPath(cwd: string): string {
  return path.join(devDir(cwd), "plane-states.json");
}

export function loadPlaneStates(cwd: string): PlaneStatesCache | null {
  try {
    const raw = fs.readFileSync(planeStatesPath(cwd), "utf-8");
    return JSON.parse(raw) as PlaneStatesCache;
  } catch {
    return null;
  }
}

export function savePlaneStates(cwd: string, cache: PlaneStatesCache): void {
  ensureDevDir(cwd);
  fs.writeFileSync(planeStatesPath(cwd), JSON.stringify(cache, null, 2), "utf-8");
}

// ── github actions cache ─────────────────────────────────────────────

export function githubDir(cwd: string): string {
  const dir = path.join(devDir(cwd), "github");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function latestCachePath(cwd: string): string {
  return path.join(githubDir(cwd), "latest.json");
}

export function runsCachePath(cwd: string): string {
  return path.join(githubDir(cwd), "runs.json");
}

export function jobsDetailPath(cwd: string, runId: number): string {
  const dir = path.join(githubDir(cwd), "jobs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${runId}.json`);
}

export function readLatestCache(cwd: string): GitHubLatestCache | null {
  try {
    const raw = fs.readFileSync(latestCachePath(cwd), "utf-8");
    return JSON.parse(raw) as GitHubLatestCache;
  } catch {
    return null;
  }
}

export function writeLatestCache(cwd: string, cache: GitHubLatestCache): void {
  ensureDevDir(cwd);
  fs.writeFileSync(latestCachePath(cwd), JSON.stringify(cache, null, 2), "utf-8");
}

export function readActionsCache(cwd: string): GitHubActionsCache | null {
  try {
    const raw = fs.readFileSync(runsCachePath(cwd), "utf-8");
    return JSON.parse(raw) as GitHubActionsCache;
  } catch {
    return null;
  }
}

export function writeActionsCache(cwd: string, cache: GitHubActionsCache): void {
  ensureDevDir(cwd);
  fs.writeFileSync(runsCachePath(cwd), JSON.stringify(cache, null, 2), "utf-8");
}

export function readJobsDetail(cwd: string, runId: number): GitHubJobsDetail | null {
  try {
    const raw = fs.readFileSync(jobsDetailPath(cwd, runId), "utf-8");
    return JSON.parse(raw) as GitHubJobsDetail;
  } catch {
    return null;
  }
}

export function writeJobsDetail(cwd: string, detail: GitHubJobsDetail): void {
  ensureDevDir(cwd);
  fs.writeFileSync(jobsDetailPath(cwd, detail.run_id), JSON.stringify(detail, null, 2), "utf-8");
}

// ── migration from old .todo/ and .sentry/ ──────────────────────────

export function migrateIfNeeded(cwd: string): boolean {
  const migrated: string[] = [];
  const oldTodo = path.join(cwd, ".todo");
  const oldSentry = path.join(cwd, ".sentry");

  ensureDevDir(cwd);

  // Migrate .todo/
  if (fs.existsSync(oldTodo)) {
    const newDev = devDir(cwd);

    // Migrate config.json
    const oldTodoConfig = path.join(oldTodo, "config.json");
    if (fs.existsSync(oldTodoConfig)) {
      try {
        const raw = fs.readFileSync(oldTodoConfig, "utf-8");
        const data: Record<string, unknown> = JSON.parse(raw);
        if (data.workspace_slug || data.project_id) {
          const cfg = loadDevConfig(cwd);
          cfg.plane = {
            workspace_slug:
              typeof data.workspace_slug === "string"
                ? data.workspace_slug
                : "",
            project_id:
              typeof data.project_id === "string" ? data.project_id : "",
            project_identifier:
              typeof data.project_identifier === "string"
                ? data.project_identifier
                : undefined,
          };
          saveDevConfig(cwd, cfg);
        }
      } catch {
        // Silently skip malformed config
      }
    }

    // Migrate cache.json → issues.json (plane issues)
    const oldCache = path.join(oldTodo, "cache.json");
    if (fs.existsSync(oldCache)) {
      try {
        const raw = fs.readFileSync(oldCache, "utf-8");
        const cache = JSON.parse(raw);
        const issues: IssuesFile["issues"] = [];
        if (Array.isArray(cache.issues)) {
          const now = new Date().toISOString();
          for (const iss of cache.issues) {
            issues.push({
              source: "plane" as const,
              id: iss.id,
              sequence_id: iss.sequence_id,
              title: iss.title,
              description: iss.description,
              state_name: iss.state_name,
              state_group: iss.state_group,
              state_hex: iss.state_hex,
              priority: iss.priority,
              link: iss.link,
              updated_at: now,
            });
          }
        }
        const current = loadIssues(cwd);
        // Only write plane issues if we don't already have them
        const hasPlaneIssues = current.issues.some(
          (i) => i.source === "plane",
        );
        if (!hasPlaneIssues && issues.length > 0) {
          saveIssues(cwd, {
            last_synced: cache.last_synced,
            issues: [...issues, ...current.issues],
          });
        }
      } catch {
        // Silently skip
      }
    }

    // Migrate time-entries.json
    const oldTimeEntries = path.join(oldTodo, "time-entries.json");
    if (fs.existsSync(oldTimeEntries)) {
      try {
        const raw = fs.readFileSync(oldTimeEntries, "utf-8");
        const store = JSON.parse(raw);
        const newPath = timeEntriesPath(cwd);
        if (!fs.existsSync(newPath) && Array.isArray(store.entries)) {
          fs.writeFileSync(newPath, raw, "utf-8");
        }
      } catch {
        // Silently skip
      }
    }

    migrated.push(".todo/");
  }

  // Migrate .sentry/
  if (fs.existsSync(oldSentry)) {
    // Migrate config.json
    const oldSentryConfig = path.join(oldSentry, "config.json");
    if (fs.existsSync(oldSentryConfig)) {
      try {
        const raw = fs.readFileSync(oldSentryConfig, "utf-8");
        const data: Record<string, unknown> = JSON.parse(raw);
        if (data.org_slug || data.project_slug) {
          const cfg = loadDevConfig(cwd);
          cfg.sentry = {
            org_slug:
              typeof data.org_slug === "string" ? data.org_slug : "",
            project_slug:
              typeof data.project_slug === "string"
                ? data.project_slug
                : "",
          };
          saveDevConfig(cwd, cfg);
        }
      } catch {
        // Silently skip
      }
    }

    // Migrate sentry JSON files → .dev/sentry/
    const sentryFiles = fs
      .readdirSync(oldSentry)
      .filter((f) => f.endsWith(".json") && f !== "config.json");
    const newSentryDir = sentryDir(cwd);

    for (const f of sentryFiles) {
      const oldPath = path.join(oldSentry, f);
      const newPath = path.join(newSentryDir, f);
      if (!fs.existsSync(newPath)) {
        try {
          fs.copyFileSync(oldPath, newPath);

          // Also upsert into issues.json
          const raw = fs.readFileSync(oldPath, "utf-8");
          const data = JSON.parse(raw);
          const issue = data.issue as Record<string, unknown> | undefined;
          if (issue) {
            const sentryId = String(issue.id ?? "");
            upsertSentryIssue(cwd, {
              source: "sentry",
              sentry_id: sentryId,
              title: String(issue.title ?? ""),
              level: String(issue.level ?? "error"),
              sentry_status: String(issue.status ?? "unresolved"),
              count:
                typeof issue.count === "number" ? issue.count : undefined,
              culprit:
                typeof issue.culprit === "string"
                  ? issue.culprit
                  : undefined,
              link:
                typeof issue.permalink === "string"
                  ? issue.permalink
                  : "",
              detail_file: `.dev/sentry/${f}`,
              updated_at: data.fetched_at ?? new Date().toISOString(),
            });
          }
        } catch {
          // Silently skip
        }
      }
    }

    migrated.push(".sentry/");
  }

  return migrated.length > 0;
}
