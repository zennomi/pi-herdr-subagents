import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  cleanupTestEnv, createTestEnv, createTrackedSurface, getAvailableBackends,
  PI_TIMEOUT, shellQuote, sleep, startPi, uniqueId, waitForFile,
} from "./harness.ts";
import { waitForShellReady } from "../../pi-extension/subagents/terminal.ts";

const herdr = (...args: string[]) => {
  const output = execFileSync("herdr", args, { encoding: "utf8", stdio: "pipe" }).trim();
  return output ? JSON.parse(output).result : undefined;
};
const entries = (path: string): any[] => !existsSync(path) ? [] : readFileSync(path, "utf8").split("\n").flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const resultFor = (path: string, tool: string) => entries(path).map((e) => e.message)
  .find((m) => m?.role === "toolResult" && m.toolName === tool);
const completions = (path: string) => entries(path).filter((e) => e.customType === "subagent_result");
async function until<T>(read: () => T, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + PI_TIMEOUT;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timeout waiting for ${label}`);
}

// Real parent + child Pi TUIs and authenticated model turns. Assertions use
// persisted tool results, not prompt text echoed on screen or Herdr idle state.
describe("Pi turn control [herdr, real LLM]", { skip: getAvailableBackends().length === 0 }, () => {
  it("interrupts without completion, accepts another turn, then resumes the saved history", { timeout: PI_TIMEOUT * 3 }, async () => {
    const env = createTestEnv("herdr");
    const id = uniqueId();
    const parentFile = join(env.dir, "parent.jsonl");
    const started = join(env.dir, "started.txt");
    const finished = join(env.dir, "must-not-finish.txt");
    const survived = join(env.dir, "survived.txt");
    const resumed = join(env.dir, "resumed.txt");
    const token = `HISTORY_${id}`;
    const notificationLog = join(env.dir, "notifications.jsonl");
    let parent: string | undefined;
    let childFile: string | undefined;
    try {
      // Transparent CLI recorder: every command still reaches the real server.
      // Record successful notification admission, not merely a mocked call.
      const bin = join(env.dir, "bin");
      mkdirSync(bin);
      const realHerdr = process.env.HERDR_BIN_PATH ?? execFileSync("which", ["herdr"], { encoding: "utf8" }).trim();
      writeFileSync(join(bin, "herdr"), `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realHerdr)}, args, { encoding: "utf8" });
if (args[0] === "notification" && result.status === 0) appendFileSync(${JSON.stringify(notificationLog)}, JSON.stringify(args) + "\\n");
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`, { mode: 0o755 });
      const recorder = join(env.dir, "record-notifications.ts");
      writeFileSync(recorder, `export default function () { process.env.PATH = ${JSON.stringify(bin)} + ":" + process.env.PATH; }`);
      const agentPath = join(env.dir, ".pi", "agents", "test-echo.md");
      writeFileSync(agentPath, readFileSync(agentPath, "utf8").replace("auto-exit: true", "auto-exit: false"));
      parent = createTrackedSurface(env, `turn-control-${id}`);
      await waitForShellReady(parent);
      startPi(parent, env.dir, [
        `Call subagent exactly once with name "Control-${id}", agent "test-echo", interactive true,`,
        `task: ${JSON.stringify(`Remember ${token}. Run bash: printf started > '${started}'; sleep 90; printf finished > '${finished}'. Do not call subagent_done; wait for further user input.`)}.`,
        "End your turn immediately after spawning. Do not poll, inspect files, or interrupt the child until I ask.",
      ].join("\n"), { extraArgs: `-e ${shellQuote(recorder)} --no-mcp --no-skills --no-context-files --approve --thinking off --session ${shellQuote(parentFile)}` });
      const launched = await until(() => resultFor(parentFile, "subagent"), "spawn tool result");
      assert.ok(!launched.isError, JSON.stringify(launched));
      const child = launched.details.surface;
      childFile = launched.details.sessionFile;
      assert.equal(herdr("pane", "get", child).pane.workspace_id, env.workspaceId);
      await waitForFile(started, PI_TIMEOUT, /started/);
      assert.ok(!existsSync(finished));
      const named = await until(() => herdr("agent", "get", child).agent.name, "automatic agent naming");
      assert.match(named, /^control-/);
      assert.equal(herdr("agent", "get", named).agent.pane_id, child);
      assert.ok(JSON.stringify(herdr("pane", "get", parent)).includes("1 running"));
      assert.equal(herdr("pane", "get", parent).pane.focused, false);

      herdr("pane", "run", parent, `Call subagent_interrupt once with id "${launched.details.id}". Do not close the child, resume it, or call any other tools.`);
      const interrupted = await until(() => resultFor(parentFile, "subagent_interrupt"), "interrupt tool result");
      assert.ok(!interrupted.isError, JSON.stringify(interrupted));
      await until(() => entries(childFile!).some((e) => e.message?.role === "toolResult"
        && e.message.toolName === "bash" && /aborted|interrupt/i.test(JSON.stringify(e.message))), "child bash cancellation");
      assert.equal(completions(parentFile).length, 0, "Escape alone must not complete the child");
      assert.ok(!existsSync(finished));
      assert.equal(herdr("agent", "get", named).agent.pane_id, child, "the same Pi process must survive");
      herdr("pane", "run", child, `Run bash: printf SURVIVED > '${survived}'. Do not call subagent_done yet.`);
      await waitForFile(survived, PI_TIMEOUT, /SURVIVED/);
      assert.equal(completions(parentFile).length, 0);
      await until(() => entries(childFile!).findLast((e) => e.message?.role === "assistant")?.message.stopReason === "stop", "surviving turn finished");
      // Exit through Pi's real command, not by killing the process or fabricating a sidecar.
      herdr("pane", "run", child, "/quit");
      const completed = await until(() => completions(parentFile)[0], "explicit child exit completion");
      assert.equal(completed.details.exitCode, 0, JSON.stringify(completed));
      assert.equal(completed.details.herdrAgentName, named);
      assert.equal(completed.details.sessionFile, childFile);
      await until(() => !JSON.stringify(herdr("pane", "get", parent!)).includes("1 running"), "parent metadata clear");
      assert.throws(() => herdr("pane", "get", child));
      await until(() => entries(notificationLog).some((args) => args[2] === `Control-${id} completed`), "unfocused completion notification accepted by Herdr");

      herdr("pane", "run", parent, [
        `Call subagent_resume exactly once with sessionPath ${JSON.stringify(childFile)}, name "Resume-${id}", autoExit true,`,
        `message: ${JSON.stringify(`Recall the HISTORY_ token from our prior conversation without reading files. Use bash to write just that token to '${resumed}'. Finish normally.`)}.`,
        "End your turn after submitting. Do not write or read the marker yourself; await the completion steer.",
      ].join("\n"));
      const resumedTool = await until(() => resultFor(parentFile, "subagent_resume"), "resume tool result");
      assert.ok(!resumedTool.isError, JSON.stringify(resumedTool));
      assert.equal((await waitForFile(resumed, PI_TIMEOUT)).trim(), token);
      const resumedResult = await until(() => completions(parentFile)[1], "resume completion");
      assert.equal(resumedResult.details.exitCode, 0, JSON.stringify(resumedResult));
      assert.equal(resumedResult.details.sessionFile, childFile);
      const childEntries = entries(childFile!);
      assert.ok(childEntries.some((e) => e.message?.role === "user" && JSON.stringify(e.message).includes(token)));
      assert.ok(childEntries.some((e) => e.message?.role === "assistant" && e.message.content?.some((c: any) =>
        c.type === "toolCall" && c.name === "bash" && c.arguments?.command?.includes(resumed))), "resumed child must execute the marker write");
      await until(() => !JSON.stringify(herdr("pane", "get", parent!)).includes("1 running"), "resume metadata clear");
    } finally {
      if (process.env.PI_TEST_EVIDENCE) {
        const evidence = join(process.env.PI_TEST_EVIDENCE, `turn-control-${id}`);
        mkdirSync(evidence, { recursive: true });
        if (existsSync(parentFile)) copyFileSync(parentFile, join(evidence, "parent.jsonl"));
        if (existsSync(notificationLog)) copyFileSync(notificationLog, join(evidence, "notifications.jsonl"));
        if (childFile && existsSync(childFile)) copyFileSync(childFile, join(evidence, "child.jsonl"));
        if (parent) {
          try { writeFileSync(join(evidence, "parent-screen.json"), JSON.stringify(herdr("pane", "read", parent, "--source", "recent-unwrapped", "--lines", "200"))); } catch {}
        }
      }
      cleanupTestEnv(env);
    }
  });
});
