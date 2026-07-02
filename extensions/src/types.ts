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
  state_name?: string;
  state_group?: string;
  state_hex?: string;
  priority?: string;

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
