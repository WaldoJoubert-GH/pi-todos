// ── shared discriminator ────────────────────────────────────────────

export type IssueSource = "plane" | "sentry";

// ── unified issue (stored in .dev/issues.json) ─────────────────────

export interface UnifiedIssue {
  source: IssueSource;
  title: string;
  link: string;
  updated_at: string;

  // Plane-specific
  id?: string;
  sequence_id?: number;
  description?: string;
  state_id?: string;
  state_name?: string;
  state_group?: string;
  state_hex?: string;
  priority?: string;
  start_date?: string;
  target_date?: string;

  // Sentry-specific
  sentry_id?: string;
  level?: string;
  sentry_status?: string;
  count?: number;
  culprit?: string;
  detail_file?: string;
}

// ── issues file (top-level) ────────────────────────────────────────

export interface IssuesFile {
  last_synced?: string;
  issues: UnifiedIssue[];
}

// ── dev config ─────────────────────────────────────────────────────

export interface DevConfig {
  plane?: PlaneConfig;
  sentry?: SentryConfig;
  autotask?: AutotaskConfig;
  github?: GitHubConfig;
}

export interface PlaneConfig {
  workspace_slug: string;
  project_id: string;
  project_identifier?: string;
}

export interface SentryConfig {
  org_slug: string;
  project_slug: string;
}

// ── time entries ───────────────────────────────────────────────────

export interface TimeEntry {
  issue_id: string;
  sequence_id: number;
  title: string;
  started_at: string;
  stopped_at: string | null;
}

export interface TimeEntryStore {
  entries: TimeEntry[];
}

// ── Plane internal types (used by plane.ts) ────────────────────────

export interface RawPlaneIssue {
  id: string;
  name: string;
  sequence_id: number;
  state: string;
  assignees: string[];
  priority: string;
  start_date: string | null;
  target_date: string | null;
  completed_at: string | null;
  created_at: string;
  project: string;
  workspace: string;
  is_draft: boolean;
  description_html?: string;
  description_stripped?: string;
}

export interface RawPlaneState {
  id: string;
  name: string;
  group: string;
  color: string;
}

// Plane cache (used internally during sync, not persisted as-is)
export interface PlaneCache {
  last_synced: string;
  workspace_slug: string;
  project_id: string;
  issues: UnifiedIssue[];
  states: Record<string, { count: number; color: string; group: string }>;
  total_active: number;
  sync_error?: boolean;
}

// ── Plane states cache ─────────────────────────────────────────────

export interface PlaneStateItem {
  id: string;
  name: string;
  color: string;
  group: string;
}

export interface PlaneStatesCache {
  last_fetched: string;
  states: PlaneStateItem[];
}

// ── Sentry internal types ──────────────────────────────────────────

export interface SentryStoredIssue {
  fetched_at: string;
  issue: Record<string, unknown>;
  latest_event_summary: Record<string, unknown>;
  full_event: Record<string, unknown> | null;
}

// ── runtime config with resolved tokens ────────────────────────────

export interface ResolvedPlaneConfig {
  token: string;
  workspace_slug: string;
  project_id: string;
  project_identifier?: string;
}

export interface ResolvedSentryConfig {
  token: string;
  org_slug: string;
  project_slug: string;
}

// ── Autotask types ──────────────────────────────────────────────────

export interface AutotaskTimeRecord {
  id: number;
  ticketID: number;
  startDateTime: string;
  endDateTime: string;
  hoursWorked: number;
  hoursToBill: number;
  summaryNotes: string;
  isNonBillable: boolean;
  dateWorked: string;
}

export interface AutotaskConfig {
  resourceId: number;
  apiBaseUrl?: string;
  utcOffset?: number;
}

export interface ResolvedAutotaskConfig {
  integrationCode: string;
  username: string;
  secret: string;
  resourceId: number;
  apiBaseUrl: string;
  utcOffset: number;
}

export interface AutotaskCache {
  fetched_at: string;
  date: string;
  items: AutotaskTimeRecord[];
}

// ── GitHub Actions types ─────────────────────────────────────────────

export interface GitHubConfig {
  repo_override?: string;
}

/** Slimmed from the GitHub REST API Workflow Run response. */
export interface GitHubRun {
  id: number;
  name: string | null;
  display_title: string;
  status: string | null;       // "queued" | "in_progress" | "completed" | "waiting" | "pending"
  conclusion: string | null;   // "success" | "failure" | "cancelled" | "skipped" | "timed_out" | "action_required" | "neutral" | "stale" | null
  head_branch: string | null;
  event: string;               // "push" | "pull_request" | "schedule" | "workflow_dispatch" | ...
  run_number: number;
  workflow_id: number;
  created_at: string;
  updated_at: string;
  run_started_at: string;
  actor_login: string;
  html_url: string;
}

export interface GitHubStep {
  name: string;
  status: string;              // "queued" | "in_progress" | "completed"
  conclusion: string | null;
  number: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface GitHubJob {
  id: number;
  run_id: number;
  name: string;
  status: string;              // "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending"
  conclusion: string | null;   // "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null
  started_at: string;
  completed_at: string | null;
  steps: GitHubStep[];
}

/** Written to .dev/github/latest.json — single most recent run for the widget. */
export interface GitHubLatestCache {
  fetched_at: string;
  owner: string;
  repo: string;
  run: GitHubRun | null;       // null when repo has no runs
}

/** Written to .dev/github/runs.json — up to 30 runs for the overlay list. */
export interface GitHubActionsCache {
  fetched_at: string;
  owner: string;
  repo: string;
  total_count: number;
  runs: GitHubRun[];
}

/** Written to .dev/github/jobs/<run_id>.json — fetched on detail drill-down. */
export interface GitHubJobsDetail {
  fetched_at: string;
  run_id: number;
  total_count: number;
  jobs: GitHubJob[];
}

/** Passed to buildWidgetLines for rendering the Actions widget pill. */
export interface GitHubWidgetStatus {
  run: GitHubRun | null;
  error?: "auth" | "api" | null;
}
