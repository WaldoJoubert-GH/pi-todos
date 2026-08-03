#!/usr/bin/env node
/**
 * Visual TUI test for GitHub Actions status icons.
 *
 * Run: npx tsx extensions/test/github-status-icons.ts
 *
 * Requires a Nerd Font-patched terminal (FiraCode Nerd Font or similar).
 * Prints each status with its icon in multiple rendering contexts:
 * 1. Standalone icon + label
 * 2. State-pill style (background filled, auto-contrast text)
 * 3. Simulated widget line alongside existing Plane/Sentry/Daily icons
 *
 * Color semantics match the ADR 0004 proposal.
 */

import { hexToAnsi } from "../src/plane.js";

// ── Status-to-icon mapping (from ADR 0004) ──────────────────────────

interface StatusIcon {
  status: string;
  iconName: string;
  codepoint: string; // e.g. "F250"
  char: string; // e.g. "\uF250"
  hex: string; // widget color
  description: string;
}

const STATUS_ICONS: StatusIcon[] = [
  {
    status: "queued",
    iconName: "nf-fa-hourglass_o",
    codepoint: "F250",
    char: "\uF250",
    hex: "#9CA3AF",
    description: "Empty hourglass — waiting to begin",
  },
  {
    status: "in_progress",
    iconName: "nf-fa-circle_o_notch",
    codepoint: "F1CE",
    char: "\uF1CE",
    hex: "#F59E0B",
    description: "Circular spinner — active execution",
  },
  {
    status: "success",
    iconName: "nf-fa-check",
    codepoint: "F00C",
    char: "\uF00C",
    hex: "#22C55E",
    description: "Check mark — passed",
  },
  {
    status: "failure",
    iconName: "nf-fa-times",
    codepoint: "F00D",
    char: "\uF00D",
    hex: "#EF4444",
    description: "X mark — failed",
  },
  {
    status: "cancelled",
    iconName: "nf-fa-minus_circle",
    codepoint: "F056",
    char: "\uF056",
    hex: "#9CA3AF",
    description: "Minus in circle — cancelled",
  },
  {
    status: "skipped",
    iconName: "nf-fa-fast_forward",
    codepoint: "F050",
    char: "\uF050",
    hex: "#6B7280",
    description: "Fast-forward arrows — skipped",
  },
  {
    status: "timed_out",
    iconName: "nf-fa-hourglass_3",
    codepoint: "F253",
    char: "\uF253",
    hex: "#EF4444",
    description: "Hourglass expired — time ran out",
  },
];

// ── Existing widget icons for side-by-side comparison ───────────────

const EXISTING_ICONS: { label: string; char: string; hex: string }[] = [
  { label: "Plane", char: "\uF273", hex: "#3B82F6" },
  { label: "Sentry", char: "\uF188", hex: "#EF4444" },
  { label: "Daily\nTotal", char: "\uF017", hex: "#8B5CF6" },
];

// ── Helpers ─────────────────────────────────────────────────────────

/** Simple ANSI reset. */
const RESET = "\x1b[0m";

/** Return a color that contrasts against the given hex background. */
function contrastColor(hex: string): string {
  // parse hex
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // relative luminance (per WCAG)
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum > 160 ? "#000000" : "#FFFFFF";
}

/** Build an ANSI background-filled pill: `[fg][bg] text [reset]` */
function pill(bgHex: string, text: string): string {
  const fg = contrastColor(bgHex);
  // Convert hex to ANSI escape: \x1b[48;2;R;G;Bm for bg, \x1b[38;2;R;G;Bm for fg
  return hexBgAnsi(bgHex) + hexFgAnsi(fg) + text + RESET;
}

function hexBgAnsi(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

function hexFgAnsi(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

// ── Test renderers ──────────────────────────────────────────────────

function renderMappingTable(): void {
  console.log(BOLD + "═".repeat(80) + RESET);
  console.log(BOLD + "  GitHub Actions Status → Nerd Font Icon Mapping" + RESET);
  console.log(BOLD + "═".repeat(80) + RESET);
  console.log("");

  // Header
  console.log(
    "  " +
      "Status".padEnd(14) +
      "Icon".padEnd(6) +
      "Codepoint".padEnd(12) +
      "NF Name".padEnd(28) +
      "Description",
  );
  console.log("  " + "─".repeat(78));

  for (const s of STATUS_ICONS) {
    const iconFg = hexFgAnsi(s.hex);
    const paddedStatus = s.status.padEnd(14);
    const paddedCode = s.codepoint.padEnd(12);
    const paddedName = s.iconName.padEnd(28);

    console.log(
      `  ${paddedStatus}${iconFg} ${s.char} ${RESET} ${paddedCode}${paddedName}${s.description}`,
    );
  }
  console.log("");
}

function renderPills(): void {
  console.log(BOLD + "─".repeat(80) + RESET);
  console.log(BOLD + "  State Pill Rendering (filled background + icon + label)" + RESET);
  console.log(BOLD + "─".repeat(80) + RESET);
  console.log("");

  const pills = STATUS_ICONS.map((s) => {
    return pill(s.hex, ` ${s.char} ${s.status} `);
  });

  // Print pills wrapped to 80 columns
  let line = "  ";
  for (const p of pills) {
    // Rough visible width estimate — Nerd Font icons are 1 cell wide
    const estimatedWidth = 4 + 2 + 10 + 2; // padding + icon + label + padding
    if (line.length + estimatedWidth > 78) {
      console.log(line);
      line = "  ";
    }
    line += p + "  ";
  }
  console.log(line);
  console.log("");

  // Also show each pill on its own line with description
  for (const s of STATUS_ICONS) {
    console.log(`  ${pill(s.hex, ` ${s.char} ${s.status} `)} ${DIM}← ${s.description}${RESET}`);
  }
  console.log("");
}

function renderWidgetSimulation(): void {
  console.log(BOLD + "─".repeat(80) + RESET);
  console.log(BOLD + "  Simulated Widget Line: Existing Icons + New Status Icons" + RESET);
  console.log(BOLD + "─".repeat(80) + RESET);
  console.log("");

  // Line 1: Existing widget count line
  const existingParts: string[] = [];
  // Simulate existing Plane count
  existingParts.push(
    hexFgAnsi("#3B82F6") + "\uF273" + RESET + " 5 todos",
  );
  // Simulate existing Sentry count
  existingParts.push(
    hexFgAnsi("#EF4444") + "\uF188" + RESET + " 2 sentry",
  );
  // Simulate existing Daily Total
  existingParts.push(
    hexFgAnsi("#8B5CF6") + "\uF017" + RESET + " 3h 22m",
  );
  console.log("  " + existingParts.join("  "));
  console.log("");

  // Line 2: GitHub Actions status line (simulating a run)
  // Example: "  main  success  ci (3m)"  — icon + branch + status pill + workflow name
  const runLineParts: string[] = [];

  // GitHub-ish indicator: use nf-fa-github (F09B) or a generic git branch icon
  const githubIcon = "\uF09B"; // nf-fa-github
  runLineParts.push(hexFgAnsi("#9CA3AF") + githubIcon + RESET + " main");

  // Show all 7 status icons in a row so you can visually compare
  for (const s of STATUS_ICONS) {
    runLineParts.push(pill(s.hex, ` ${s.char} ${s.status} `));
  }

  console.log("  " + runLineParts.join(" "));
  console.log("");

  // Line 3: Running entry simulation alongside GitHub run
  const runningLineParts: string[] = [];
  // Simulate a running CI job
  const runningIcon = STATUS_ICONS.find((s) => s.status === "in_progress")!;
  runningLineParts.push(
    pill(runningIcon.hex, ` ${runningIcon.char} ci `) + " " + DIM + "build → test → deploy (12m 34s)" + RESET,
  );
  console.log("  " + runningLineParts.join(""));
  console.log("");

  // Line 4: Completed run examples
  console.log("  " + BOLD + "Simulated run conclusions:" + RESET);
  console.log(
    "  " +
      pill("#22C55E", ` ${STATUS_ICONS[2].char} ci passed `) +
      "  " +
      DIM + "main · #42 · 2m ago" + RESET,
  );
  console.log(
    "  " +
      pill("#EF4444", ` ${STATUS_ICONS[3].char} deploy failed `) +
      "  " +
      DIM + "main · #41 · 5m ago" + RESET,
  );
  console.log(
    "  " +
      pill("#9CA3AF", ` ${STATUS_ICONS[4].char} lint cancelled `) +
      "  " +
      DIM + "feat/x · #40 · 1h ago" + RESET,
  );
  console.log(
    "  " +
      pill("#6B7280", ` ${STATUS_ICONS[5].char} e2e skipped `) +
      "  " +
      DIM + "dependabot/npm · #39 · 3h ago" + RESET,
  );
  console.log(
    "  " +
      pill("#EF4444", ` ${STATUS_ICONS[6].char} ci timed_out `) +
      "  " +
      DIM + "main · #38 · 1d ago" + RESET,
  );
  console.log("");
}

function renderCohesionTest(): void {
  console.log(BOLD + "─".repeat(80) + RESET);
  console.log(BOLD + "  Visual Cohesion Test: All Icons Side-by-Side" + RESET);
  console.log(BOLD + "─".repeat(80) + RESET);
  console.log("");

  // One row per existing icon + all 7 new icons
  const testRows: { label: string; chars: string[]; hexes: string[] }[] = [
    {
      label: "Existing",
      chars: EXISTING_ICONS.map((e) => e.char),
      hexes: EXISTING_ICONS.map((e) => e.hex),
    },
    {
      label: "Proposed",
      chars: STATUS_ICONS.map((s) => s.char),
      hexes: STATUS_ICONS.map((s) => s.hex),
    },
  ];

  for (const row of testRows) {
    let line = `  ${row.label.padEnd(10)} `;
    for (let i = 0; i < row.chars.length; i++) {
      line += hexFgAnsi(row.hexes[i]) + row.chars[i] + RESET + "  ";
    }
    console.log(line);
  }

  console.log("");
  console.log(
    "  " +
      DIM +
      "↑ Top row = existing widget icons. Bottom row = proposed status icons." +
      RESET,
  );
  console.log(
    "  " +
      DIM +
      "They should look like they belong together — same weight, same design language." +
      RESET,
  );
  console.log("");
}

// ── Main ────────────────────────────────────────────────────────────

console.log("");
renderMappingTable();
renderPills();
renderWidgetSimulation();
renderCohesionTest();

console.log(BOLD + "═".repeat(80) + RESET);
console.log(
  "  " +
    DIM +
    "Test complete. If any icons show as tofu (□ or �), your terminal font" +
    RESET,
);
console.log(
  "  " +
    DIM +
    "is not Nerd Font-patched. Install FiraCode Nerd Font or equivalent." +
    RESET,
);
console.log(BOLD + "═".repeat(80) + RESET);
console.log("");
