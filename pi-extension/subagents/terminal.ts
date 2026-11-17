import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  closeHerdrSurface,
  closeHerdrSurfaceAsync,
  createHerdrSurfaceAsync,
  createHerdrSurfaceSplitAsync,
  sendHerdrCommandAsync,
  reportHerdrPaneMetadataAsync,
  getPaneProcessInfo,
  isShellIdle,
  getPaneLayout,
  type PaneLayout,
  createHerdrSurface,
  createHerdrSurfaceSplit,
  isHerdrAvailable,
  readHerdrScreen,
  readHerdrScreenAsync,
  inspectHerdrPane,
  renameHerdrTab,
  renameHerdrWorkspace,
  reportHerdrPaneTask,
  sendHerdrCommand,
  sendHerdrEscape,
  sendHerdrEscapeAsync,
} from "./herdr.ts";

export type PaneId = string;
export type SplitDirection = "right" | "down";

/**
 * Where a subagent surface should be created:
 *   - `"tab"`   — a brand-new tab (default)
 *   - `"right"` — split the orchestrator pane to the right
 *   - `"down"`  — split the orchestrator pane below
 */
export type SubagentLayout = "tab" | "auto" | SplitDirection;

const SETUP_HINT = "Start pi inside herdr (`herdr`, then run `pi`).";

/**
 * Parse the `PI_SUBAGENT_LAYOUT` env var into a {@link SubagentLayout}.
 * Accepted values (case-sensitive, trimmed): `split`, `split:right` (both map
 * to a right-hand split), `split:down` (split below). Anything else — unset,
 * empty, or unknown — falls back to the default `tab`.
 */
export function parseSubagentLayout(raw?: string): SubagentLayout {
  const value = (raw ?? "").trim();
  if (value === "split" || value === "split:right") return "right";
  if (value === "split:down") return "down";
  if (value === "split:auto") return "auto";
  return "tab";
}

/** Read `PI_SUBAGENT_LAYOUT` from the provided environment (defaults to the process env). */
export function resolveSubagentLayout(env: Record<string, string | undefined> = process.env): SubagentLayout {
  return parseSubagentLayout(env.PI_SUBAGENT_LAYOUT);
}

/** Create the surface for a subagent according to the requested layout. */
export function createSubagentSurface(name: string, layout: SubagentLayout = "tab", cwd = process.cwd()): PaneId {
  assertTerminalAvailable();
  return layout === "tab" ? createSubagentPane(name, cwd) : splitCurrentPane(name, layout === "auto" ? "right" : layout, cwd);
}

export async function createSubagentSurfaceAsync(name: string, layout: SubagentLayout = "tab", cwd = process.cwd()): Promise<PaneId> {
  assertTerminalAvailable();
  if (layout === "tab") return createHerdrSurfaceAsync(name, cwd);
  let direction: SplitDirection = layout === "auto" ? "right" : layout;
  if (layout === "auto" && process.env.HERDR_PANE_ID) {
    try { direction = resolveAutoSplitDirection(await getPaneLayout(process.env.HERDR_PANE_ID), process.env.HERDR_PANE_ID); }
    catch { /* Older servers: retain right-hand splits. */ }
  }
  return createHerdrSurfaceSplitAsync(name, direction, cwd);
}

export function resolveAutoSplitDirection(layout: PaneLayout, pane = process.env.HERDR_PANE_ID): SplitDirection {
  const rect = layout.panes.find((item) => item.pane_id === pane)?.rect;
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return "right";
  return rect.width >= 2.5 * rect.height ? "right" : "down";
}

export async function closePaneAsync(pane: PaneId): Promise<void> {
  assertTerminalAvailable();
  await closeHerdrSurfaceAsync(pane);
}

export async function setPaneTaskAsync(pane: PaneId, task: string, displayAgent?: string): Promise<void> {
  if (isTerminalAvailable()) await reportHerdrPaneMetadataAsync(pane, { task, displayAgent });
}

function envMilliseconds(value: string | undefined, fallback: number): number {
  if (value == null || !value.trim()) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function getShellReadyDelayMs(): number {
  return envMilliseconds(process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS, 500);
}

/** Foreground-process observations are a readiness heuristic, not a prompt protocol. */
export async function waitForShellReady(pane: PaneId, options: { timeoutMs?: number; settleMs?: number } = {}, deps = {
  inspect: getPaneProcessInfo,
  now: Date.now,
  delay: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  env: process.env as Record<string, string | undefined>,
}): Promise<void> {
  const started = deps.now();
  const timeout = options.timeoutMs ?? envMilliseconds(deps.env.PI_SUBAGENT_SHELL_READY_TIMEOUT_MS, 5000);
  const floor = envMilliseconds(deps.env.PI_SUBAGENT_SHELL_READY_DELAY_MS, 0);
  const fallback = envMilliseconds(deps.env.PI_SUBAGENT_SHELL_READY_DELAY_MS, 500);
  const settle = options.settleMs ?? 100;
  let idleSamples = 0;
  while (deps.now() - started < timeout) {
    let info;
    try { info = await deps.inspect(pane, Math.max(1, Math.min(1000, timeout - (deps.now() - started)))); }
    catch {
      // Older servers lack process-info. Preserve the historical minimum delay.
      await deps.delay(Math.max(0, fallback - (deps.now() - started)));
      return;
    }
    idleSamples = isShellIdle(info) ? idleSamples + 1 : 0;
    if (idleSamples >= 2) {
      await deps.delay(Math.max(settle, floor - (deps.now() - started)));
      // Shell startup can briefly return to its own process group between jobs.
      // Recheck after settling rather than sending into a newly started init job.
      try {
        if (isShellIdle(await deps.inspect(pane, 1000))) return;
      } catch {
        await deps.delay(Math.max(0, fallback - (deps.now() - started)));
        return;
      }
      idleSamples = 0;
    }
    await deps.delay(Math.min(50, Math.max(0, timeout - (deps.now() - started))));
  }
  throw new Error(`Shell in ${pane} did not become ready within ${timeout}ms; command not submitted`);
}

export function isTerminalAvailable(): boolean {
  return isHerdrAvailable();
}

export function terminalSetupHint(): string {
  return SETUP_HINT;
}

function assertTerminalAvailable(): void {
  if (!isTerminalAvailable()) throw new Error(`herdr is not available. ${SETUP_HINT}`);
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Create a new herdr tab and return its root pane ID. */
export function createSubagentPane(name: string, cwd = process.cwd()): PaneId {
  assertTerminalAvailable();
  return createHerdrSurface(name, cwd);
}

/** Split the current herdr pane and return the child pane ID. */
export function splitCurrentPane(name: string, direction: SplitDirection, cwd = process.cwd()): PaneId {
  assertTerminalAvailable();
  return createHerdrSurfaceSplit(name, direction, cwd);
}

export function renameCurrentTab(title: string): void {
  assertTerminalAvailable();
  renameHerdrTab(title);
}

export function renameCurrentWorkspace(title: string): void {
  assertTerminalAvailable();
  renameHerdrWorkspace(title);
}

export function runInPane(paneId: PaneId, command: string): void {
  assertTerminalAvailable();
  sendHerdrCommand(paneId, command);
}

export function interruptPane(paneId: PaneId): void {
  assertTerminalAvailable();
  sendHerdrEscape(paneId);
}

export async function interruptPaneAsync(pane: PaneId): Promise<void> {
  assertTerminalAvailable();
  await sendHerdrEscapeAsync(pane);
}

function writePaneScript(
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-herdr-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptLines = ["#!/bin/bash"];
  if (options?.scriptPreamble) scriptLines.push(options.scriptPreamble.trimEnd());
  scriptLines.push(command);
  writeFileSync(scriptPath, `${scriptLines.join("\n")}\n`, { mode: 0o755 });

  return scriptPath;
}

export function runScriptInPane(paneId: PaneId, command: string, options?: { scriptPath?: string; scriptPreamble?: string }): string {
  const path = writePaneScript(command, options);
  runInPane(paneId, `bash ${shellQuote(path)}`);
  return path;
}

export async function runScriptInPaneAsync(paneId: PaneId, command: string, options?: { scriptPath?: string; scriptPreamble?: string }): Promise<string> {
  assertTerminalAvailable();
  const path = writePaneScript(command, options);
  await sendHerdrCommandAsync(paneId, `bash ${shellQuote(path)}`);
  return path;
}

export function readPane(paneId: PaneId, lines = 50): string {
  assertTerminalAvailable();
  return readHerdrScreen(paneId, lines);
}

export async function readPaneAsync(paneId: PaneId, lines = 50): Promise<string> {
  assertTerminalAvailable();
  return readHerdrScreenAsync(paneId, lines);
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

export async function inspectPane(paneId: PaneId): Promise<import("./lifecycle.ts").PaneInspection> {
  assertTerminalAvailable();
  const result = await inspectHerdrPane(paneId);
  if (result.kind === "present") {
    return { kind: "present", observedAt: Date.now(), ...result };
  }
  return result;
}

export function closePane(paneId: PaneId): void {
  assertTerminalAvailable();
  closeHerdrSurface(paneId);
}

export function setPaneTask(paneId: PaneId, task: string): void {
  if (!isTerminalAvailable()) return;
  reportHerdrPaneTask(paneId, task);
}
