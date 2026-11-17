import { execFile, execSync, execFileSync } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { getEnvironmentConfig } from "./config.ts";

const execFileAsync = promisify(execFile);

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } catch {
      try {
        execSync(`command -v ${command}`, { stdio: "ignore" });
        available = true;
      } catch {
        available = false;
      }
    }
  } else {
    try {
      execSync(`command -v ${command}`, { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  }

  commandAvailability.set(command, available);
  return available;
}

let serverAvailable = false;

function herdrServerReachable(): boolean {
  if (!serverAvailable) serverAvailable = listHerdrWorkspaces() !== null;
  return serverAvailable;
}

export function isHerdrAvailable(): boolean {
  if (!hasCommand("herdr")) return false;
  if (process.env.HERDR_ENV === "1") return true;
  if (!getEnvironmentConfig().allowOutsideHerdr) return false;
  return herdrServerReachable();
}

function parseHerdrJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractHerdrPaneId(output: string, context: string): string {
  const parsed = parseHerdrJson(output);
  const paneId = (parsed as { result?: { pane?: { pane_id?: unknown } } })?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`);
  }
  return paneId;
}

function extractHerdrRootPaneId(output: string, context: string): string {
  const parsed = parseHerdrJson(output);
  const paneId = (parsed as { result?: { root_pane?: { pane_id?: unknown } } })?.result?.root_pane
    ?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`);
  }
  return paneId;
}

function herdrExec(args: string[]): string {
  return execFileSync("herdr", args, { encoding: "utf8" });
}

async function herdrExecAsync(args: string[], timeout = 5000): Promise<string> {
  const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8", timeout });
  return stdout;
}

type PaneIdentity = {
  pane_id?: string;
  tab_id?: string;
  workspace_id?: string;
};

function parseCurrentPane(output: string): PaneIdentity {
  const parsed = parseHerdrJson(output) as { result?: { pane?: Record<string, unknown> } } | null;
  const pane = parsed?.result?.pane;
  return {
    pane_id: typeof pane?.pane_id === "string" ? pane.pane_id : undefined,
    tab_id: typeof pane?.tab_id === "string" ? pane.tab_id : undefined,
    workspace_id: typeof pane?.workspace_id === "string" ? pane.workspace_id : undefined,
  };
}

function parseFirstWorkspaceId(output: string): string | null {
  const parsed = parseHerdrJson(output) as {
    result?: { workspaces?: unknown };
    workspaces?: unknown;
  } | null;
  const workspaces = parsed?.result?.workspaces ?? parsed?.workspaces;
  if (!Array.isArray(workspaces)) return null;
  const first = workspaces[0];
  if (first == null || typeof first !== "object") return null;
  const id = (first as { workspace_id?: unknown }).workspace_id;
  return typeof id === "string" && id ? id : null;
}

function readCurrentPane(): PaneIdentity {
  try {
    return parseCurrentPane(herdrExec(["pane", "current"]));
  } catch {
    return {};
  }
}

function listHerdrWorkspaces(): string | null {
  try {
    return herdrExec(["workspace", "list"]);
  } catch {
    return null;
  }
}

export function getHerdrParentPaneId(): string | null {
  return process.env.HERDR_PANE_ID || readCurrentPane().pane_id || null;
}

function resolveHerdrWorkspaceId(): string {
  const workspaceId = process.env.HERDR_WORKSPACE_ID || readCurrentPane().workspace_id;
  if (workspaceId) return workspaceId;
  const output = listHerdrWorkspaces();
  const fallback = output === null ? null : parseFirstWorkspaceId(output);
  if (fallback) return fallback;
  throw new Error("Cannot resolve a herdr workspace from HERDR_WORKSPACE_ID, pane current, or workspace list.");
}

function buildTabCreateArgs(name: string, cwd: string, workspaceId: string): string[] {
  return [
    "tab",
    "create",
    "--workspace",
    workspaceId,
    "--label",
    name,
    "--cwd",
    cwd,
    "--no-focus",
  ];
}

export function createHerdrSurface(name: string, cwd = process.cwd()): string {
  const workspaceId = resolveHerdrWorkspaceId();
  const output = herdrExec(buildTabCreateArgs(name, cwd, workspaceId));
  const paneId = extractHerdrRootPaneId(output, "tab create");
  try {
    herdrExec(["pane", "rename", paneId, name]);
  } catch {
    // Optional — pane label is cosmetic.
  }
  return paneId;
}

function buildPaneSplitArgs(
  parentPaneId: string,
  direction: "right" | "down",
  cwd: string,
): string[] {
  return [
    "pane",
    "split",
    parentPaneId,
    "--direction",
    direction,
    "--no-focus",
    "--cwd",
    cwd,
  ];
}

export function createHerdrSurfaceSplit(
  name: string,
  direction: "right" | "down",
  parentPaneId: string,
  cwd = process.cwd(),
): string {
  const output = herdrExec(buildPaneSplitArgs(parentPaneId, direction, cwd));
  const paneId = extractHerdrPaneId(output, "pane split");
  try {
    herdrExec(["pane", "rename", paneId, name]);
  } catch {
    // Optional.
  }
  return paneId;
}

export function readHerdrScreen(surface: string, lines = 50): string {
  // `visible` is reliable for freshly created panes where herdr's `recent`
  // scrollback may not be populated yet.
  return herdrExec(["pane", "read", surface, "--source", "visible", "--lines", String(lines)]);
}

export async function readHerdrScreenAsync(surface: string, lines = 50): Promise<string> {
  return herdrExecAsync(["pane", "read", surface, "--source", "visible", "--lines", String(lines)]);
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

type PaneInspectionResult =
  | { kind: "present"; agent?: string; agentSession?: import("./lifecycle.ts").HerdrAgentSession; agentStatus: "idle" | "working" | "blocked" | "done" | "unknown" }
  | { kind: "missing"; error?: string }
  | { kind: "unavailable"; error: string };

function parsePaneGetOutput(output: string, surface: string): PaneInspectionResult {
  const parsed = parseHerdrJson(output) as
    | { result?: { pane?: unknown }; error?: { code?: unknown; message?: unknown } }
    | null;
  const errorObj = parsed?.error;
  if (errorObj?.code === "pane_not_found" || errorObj?.code === "not_found") {
    return { kind: "missing", error: typeof errorObj.message === "string" ? errorObj.message : "pane not found" };
  }
  const pane = parsed?.result?.pane;
  if (!pane || typeof pane !== "object") return { kind: "unavailable", error: "pane get returned no pane record" };
  const record = pane as { pane_id?: unknown; agent?: unknown; agent_status?: unknown; agent_session?: unknown };
  if (record.pane_id !== surface) return { kind: "unavailable", error: "pane id mismatch" };
  const agent = typeof record.agent === "string" ? record.agent : undefined;
  const rawStatus = typeof record.agent_status === "string" ? record.agent_status : "unknown";
  const agentStatus = rawStatus === "idle" ||
      rawStatus === "working" ||
      rawStatus === "blocked" ||
      rawStatus === "done" ||
      rawStatus === "unknown"
    ? rawStatus
    : "unknown";
  const session = record.agent_session as Partial<import("./lifecycle.ts").HerdrAgentSession> | undefined;
  const agentSession = session && (session.kind === "path" || session.kind === "id") && typeof session.value === "string" && session.value
    ? { kind: session.kind, value: session.value, ...(typeof session.agent === "string" ? { agent: session.agent } : {}) } : undefined;
  return { kind: "present", ...(agent ? { agent } : {}), agentStatus, ...(agentSession ? { agentSession } : {}) };
}

function parsePaneGetError(error: any): PaneInspectionResult {
  for (const raw of [error?.stderr, error?.stdout]) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    try {
      const parsed = parsePaneGetOutput(raw, "");
      if (parsed.kind === "missing") return parsed;
    } catch {
      // A CLI may emit plain diagnostics on one stream and structured JSON on
      // the other. Parse each stream independently before giving up.
    }
    // Older/alternate Herdr builds may print the stable error code as plain
    // text rather than JSON. Only match explicit identifiers, not generic
    // prose such as "pane unavailable".
    if (/\b(?:pane_not_found|not_found)\b/.test(raw)) {
      return { kind: "missing", error: raw.trim() };
    }
  }
  const message = error?.message ? String(error.message) : "herdr pane get failed";
  return { kind: "unavailable", error: message };
}

/**
 * Structured pane query.
 * - present: pane is reachable; agent/agentStatus may be present when detected
 * - missing: server responded, pane is gone
 * - unavailable: server command failed; caller should keep polling
 */
export async function inspectHerdrPane(surface: string): Promise<PaneInspectionResult> {
  try {
    return parsePaneGetOutput(await herdrExecAsync(["pane", "get", surface]), surface);
  } catch (error: any) {
    return parsePaneGetError(error);
  }
}

export function sendHerdrCommand(surface: string, command: string): void {
  // pane run sends the text and Enter in a single socket request, avoiding
  // a race where Enter could arrive before the text is fully processed.
  herdrExec(["pane", "run", surface, command]);
}

export function sendHerdrEscape(surface: string): void {
  herdrExec(["pane", "send-keys", surface, "Escape"]);
}

function isPaneMissingError(error: any): boolean {
  return parsePaneGetError(error).kind === "missing";
}

export function closeHerdrSurface(surface: string): void {
  try {
    herdrExec(["pane", "close", surface]);
  } catch (error: any) {
    // Closing a pane is cleanup. If the pane already disappeared (for example,
    // after an interrupt or manual close), the desired end state is satisfied.
    if (isPaneMissingError(error)) return;
    throw error;
  }
}

export function renameHerdrTab(title: string): void {
  const tabId = process.env.HERDR_TAB_ID || readCurrentPane().tab_id;
  if (!tabId) throw new Error("Cannot rename herdr tab: no current tab is available.");
  herdrExec(["tab", "rename", tabId, title]);
}

export function renameHerdrWorkspace(title: string): void {
  const workspaceId = resolveHerdrWorkspaceId();
  herdrExec(["workspace", "rename", workspaceId, title]);
}

function buildPaneReportTaskArgs(
  paneId: string,
  task: string,
  source = "pi",
): string[] {
  const normalizedTask = task.replace(/[\r\n\t]+/g, " ").trim();
  return [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    source,
    "--token",
    `task=${normalizedTask}`,
  ];
}

export function reportHerdrPaneTask(
  paneId: string,
  task: string,
  source = "pi",
): void {
  const normalizedTask = task.replace(/[\r\n\t]+/g, " ").trim();
  if (!normalizedTask) return;
  try {
    herdrExec(buildPaneReportTaskArgs(paneId, normalizedTask, source));
  } catch {
    // Non-fatal: cosmetic metadata report failure should not abort subagent launch.
  }
}

function canFallbackAgentKeys(error: any): boolean {
  for (const raw of [error?.stderr, error?.stdout]) {
    if (typeof raw !== "string") continue;
    const parsed = parseHerdrJson(raw) as any;
    if (["agent_not_found", "no_agent", "unknown_command", "method_not_found"].includes(parsed?.error?.code)) return true;
    if (/\b(?:agent_not_found|no_agent|unknown_command|method_not_found)\b|unknown (?:command|subcommand)|no agent (?:detected|found)/i.test(raw)) return true;
  }
  return false;
}

export async function sendHerdrEscapeAsync(pane: string, exec = herdrExecAsync): Promise<void> {
  try { await exec(["agent", "send-keys", pane, "esc"]); }
  catch (error) {
    // Do not duplicate input on ambiguous transport failures or timeouts.
    if (!canFallbackAgentKeys(error)) throw error;
    await exec(["pane", "send-keys", pane, "Escape"]);
  }
}

export async function renameHerdrAgent(pane: string, name: string): Promise<void> {
  await herdrExecAsync(["agent", "rename", pane, name]);
}

export async function renameHerdrPaneAsync(pane: string, name: string): Promise<void> {
  try { await herdrExecAsync(["pane", "rename", pane, name]); } catch { /* Cosmetic. */ }
}

export async function createHerdrSurfaceAsync(name: string, cwd = process.cwd()): Promise<string> {
  let workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (!workspaceId) {
    try { workspaceId = parseCurrentPane(await herdrExecAsync(["pane", "current"])).workspace_id; }
    catch { /* Outside Herdr there may be no current pane. */ }
  }
  if (!workspaceId) {
    workspaceId = parseFirstWorkspaceId(await herdrExecAsync(["workspace", "list"])) ?? undefined;
    if (!workspaceId) throw new Error("Unable to resolve caller workspace");
  }
  const pane = extractHerdrRootPaneId(await herdrExecAsync(buildTabCreateArgs(name, cwd, workspaceId)), "tab create");
  await renameHerdrPaneAsync(pane, name);
  return pane;
}

export async function createHerdrSurfaceSplitAsync(name: string, direction: "right" | "down", cwd = process.cwd()): Promise<string> {
  let parentPaneId = process.env.HERDR_PANE_ID;
  if (!parentPaneId) {
    try { parentPaneId = parseCurrentPane(await herdrExecAsync(["pane", "current"])).pane_id; }
    catch { /* Outside Herdr, fall back to a new tab. */ }
  }
  if (!parentPaneId) return createHerdrSurfaceAsync(name, cwd);
  const pane = extractHerdrPaneId(await herdrExecAsync(buildPaneSplitArgs(parentPaneId, direction, cwd)), "pane split");
  await renameHerdrPaneAsync(pane, name);
  return pane;
}

export async function sendHerdrCommandAsync(pane: string, command: string): Promise<void> {
  // Never retry a submission: a lost response does not prove non-delivery.
  await herdrExecAsync(["pane", "run", pane, command]);
}

export async function closeHerdrSurfaceAsync(pane: string): Promise<void> {
  try { await herdrExecAsync(["pane", "close", pane]); }
  catch (error) { if (!isPaneMissingError(error)) throw error; }
}

export interface PaneMetadata {
  task?: string;
  displayAgent?: string;
  subagents?: number;
  seq?: number;
}

export function buildPaneMetadataArgs(pane: string, metadata: PaneMetadata): string[] {
  const args = ["pane", "report-metadata", pane, "--source", "pi-herdr-subagents"];
  if (metadata.task?.trim()) args.push("--token", "task=" + metadata.task.replace(/[\r\n\t]+/g, " ").trim());
  if (metadata.displayAgent) args.push("--display-agent", metadata.displayAgent.replace(/[\r\n\t]+/g, " "));
  if (metadata.subagents != null) {
    if (metadata.subagents > 0) args.push("--token", `subagents=${metadata.subagents} running`, "--ttl-ms", "120000");
    else args.push("--clear-token", "subagents");
  }
  if (metadata.seq != null) args.push("--seq", String(metadata.seq));
  return args;
}

export async function reportHerdrPaneMetadataAsync(pane: string, metadata: string | PaneMetadata): Promise<void> {
  if (process.env.PI_SUBAGENT_HERDR_METADATA === "0") return;
  try { await herdrExecAsync(buildPaneMetadataArgs(pane, typeof metadata === "string" ? { task: metadata } : metadata)); }
  catch { /* Cosmetic: unsupported metadata never prevents a launch or delivery. */ }
}

export function buildNotificationArgs(name: string, status: "completed" | "failed" | "needs help", summary: string): string[] {
  const title = name.replace(/[\r\n\t]+/g, " ").slice(0, 80) + " " + status;
  const firstLine = summary.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const body = Array.from(stripVTControlCharacters(firstLine)).slice(0, 120).join("");
  return ["notification", "show", title, "--body", body, "--sound", status === "completed" ? "done" : "request"];
}

export async function notifyHerdrCompletion(parentPane: string, name: string, status: "completed" | "failed" | "needs help", summary: string, exec = herdrExecAsync): Promise<void> {
  if (process.env.PI_SUBAGENT_HERDR_NOTIFY === "0") return;
  try {
    const data = parseHerdrJson(await exec(["pane", "get", parentPane])) as any;
    if (data?.result?.pane?.pane_id !== parentPane || data.result.pane.focused !== false) return;
    await exec(buildNotificationArgs(name, status, summary));
  } catch { /* Notifications must not affect authoritative result delivery. */ }
}

export interface PaneLayout {
  panes: Array<{ pane_id: string; rect: { width: number; height: number } }>;
}

export async function getPaneLayout(pane: string): Promise<PaneLayout> {
  const parsed = parseHerdrJson(await herdrExecAsync(["pane", "layout", "--pane", pane])) as any;
  const layout = parsed?.result?.layout;
  if (!Array.isArray(layout?.panes)) throw new Error("Unsupported pane layout response");
  return layout;
}

export interface PaneProcessInfo {
  shell_pid: number;
  foreground_process_group_id: number;
  foreground_processes: Array<{ pid: number }>;
}

export function isShellIdle(info: PaneProcessInfo): boolean {
  return Number.isInteger(info.shell_pid) && info.shell_pid > 0
    && info.foreground_process_group_id === info.shell_pid
    && Array.isArray(info.foreground_processes) && info.foreground_processes.length > 0
    && info.foreground_processes.every((process) => process.pid === info.shell_pid);
}

export async function getPaneProcessInfo(pane: string, timeout = 1000): Promise<PaneProcessInfo> {
  const parsed = parseHerdrJson(await herdrExecAsync(["pane", "process-info", "--pane", pane], timeout)) as any;
  const info = parsed?.result?.process_info;
  if (!info || typeof info.shell_pid !== "number" || typeof info.foreground_process_group_id !== "number"
    || !Array.isArray(info.foreground_processes)) throw new Error("Unsupported pane process-info response");
  return info;
}

export const __herdrTest__ = {
  canFallbackAgentKeys,
  buildPaneMetadataArgs,
  buildNotificationArgs,
  buildTabCreateArgs,
  buildPaneSplitArgs,
  buildPaneReportTaskArgs,
  parseHerdrJson,
  extractHerdrPaneId,
  extractHerdrRootPaneId,
  parsePaneGetOutput,
  parsePaneGetError,
  isPaneMissingError,
};
