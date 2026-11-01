import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createTestEnv, cleanupTestEnv, getAvailableBackends, waitForFile, waitForScreen, TEST_MODEL } from "./harness.ts";
import {
  createSubagentSurfaceAsync, waitForShellReady, runScriptInPaneAsync,
  closePaneAsync, resolveAutoSplitDirection, shellQuote,
} from "../../pi-extension/subagents/terminal.ts";
import { getPaneLayout, getPaneProcessInfo, isShellIdle, reportHerdrPaneMetadataAsync, renameHerdrAgent } from "../../pi-extension/subagents/herdr.ts";

const herdr = (...args: string[]) => {
  const output = execFileSync("herdr", args, { encoding: "utf8" }).trim();
  return output ? JSON.parse(output).result : undefined;
};

describe("async Herdr surfaces [real server, no LLM]", { skip: getAvailableBackends().length === 0 }, () => {
  it("creates in the child cwd, waits for the shell, delivers a script and closes idempotently", { timeout: 30_000 }, async () => {
    const env = createTestEnv("herdr");
    try {
      const cwd = join(env.dir, "child with spaces");
      mkdirSync(cwd);
      const focused = herdr("pane", "current").pane.pane_id;
      const pane = await createSubagentSurfaceAsync("async cwd", "tab", cwd);
      env.surfaces.push(pane);
      assert.equal(realpathSync(herdr("pane", "get", pane).pane.cwd), realpathSync(cwd));
      await waitForShellReady(pane, { timeoutMs: 8000 });
      assert.equal(isShellIdle(await getPaneProcessInfo(pane)), true);
      const marker = join(cwd, "marker.txt");
      await runScriptInPaneAsync(pane, `printf ASYNC_REAL_OK > ${shellQuote(marker)}`, { scriptPath: join(env.dir, "launch.sh") });
      assert.equal(await waitForFile(marker, 5000, /ASYNC_REAL_OK/), "ASYNC_REAL_OK");
      assert.equal(herdr("pane", "current").pane.pane_id, focused);
      await closePaneAsync(pane);
      await closePaneAsync(pane);
      env.surfaces = env.surfaces.filter((id) => id !== pane);
    } finally { cleanupTestEnv(env); }
  });

  it("names a real Pi child and preserves Ctrl+J alongside Alt+J and the command", { timeout: 30_000 }, async () => {
    const env = createTestEnv("herdr");
    try {
      const pane = await createSubagentSurfaceAsync("widget verification", "tab", env.dir);
      env.surfaces.push(pane);
      await waitForShellReady(pane, { timeoutMs: 8000 });
      const childExtension = fileURLToPath(new URL("../../pi-extension/subagents/subagent-done.ts", import.meta.url));
      const editorProof = join(env.dir, "editor-proof.json");
      const probe = join(env.dir, "editor-probe.ts");
      // Observe the real editor through Pi's API; never substitute a test editor.
      // A mistaken submit is counted and handled so the no-LLM test stays offline.
      writeFileSync(probe, `import { writeFileSync } from "node:fs";
export default function (pi) {
  let submittedInputs = 0;
  pi.on("input", () => { submittedInputs++; return { action: "handled" }; });
  pi.registerShortcut("alt+x", { description: "Capture editor proof", handler: async (ctx) => {
    writeFileSync(${JSON.stringify(editorProof)}, JSON.stringify({ editor: ctx.ui.getEditorText(), submittedInputs }));
  } });
}
`);
      const command = ["pi", "-ne", "-e", childExtension, "-e", probe, "--no-skills", "--no-context-files", "--approve", "--model", TEST_MODEL,
        "--session", join(env.dir, "ui.jsonl")].map(shellQuote).join(" ");
      await runScriptInPaneAsync(pane, "PI_SUBAGENT_NAME=verify-ui PI_SUBAGENT_AUTO_EXIT=0 " + command, { scriptPath: join(env.dir, "ui-launch.sh") });
      await waitForScreen(pane, /Alt\+J to expand/, 15000);
      const name = "verify-ui-" + Date.now().toString(36);
      await renameHerdrAgent(pane, name);
      assert.equal(herdr("agent", "get", name).agent.pane_id, pane);
      herdr("agent", "send-keys", name, "alt+j");
      await waitForScreen(pane, /Alt\+J to collapse/, 5000);
      herdr("pane", "send-text", pane, "EDITOR_LINE_ONE");
      herdr("agent", "send-keys", name, "ctrl+j");
      herdr("pane", "send-text", pane, "EDITOR_LINE_TWO");
      const screen = await waitForScreen(pane, /EDITOR_LINE_TWO/, 5000);
      const lines = screen.split("\n");
      const first = lines.findIndex((line) => line.includes("EDITOR_LINE_ONE"));
      const second = lines.findIndex((line) => line.includes("EDITOR_LINE_TWO"));
      assert.ok(first >= 0 && second > first, "both editor markers must be visible on separate lines");
      herdr("agent", "send-keys", name, "alt+x");
      const proof = JSON.parse(await waitForFile(editorProof, 5000));
      assert.equal(proof.editor, "EDITOR_LINE_ONE\nEDITOR_LINE_TWO");
      assert.equal(proof.submittedInputs, 0, "Ctrl+J must not submit an input turn");
      herdr("agent", "send-keys", name, "ctrl+c");
      herdr("pane", "run", pane, "/subagent-tools");
      await waitForScreen(pane, /Alt\+J to expand/, 5000);
    } finally { cleanupTestEnv(env); }
  });

  it("waits through a slow isolated zsh startup rc", { timeout: 15_000, skip: !process.env.SHELL?.endsWith("zsh") }, async () => {
    const env = createTestEnv("herdr");
    try {
      const rc = join(env.dir, "isolated-rc");
      mkdirSync(rc);
      const ready = join(env.dir, "rc-ready");
      writeFileSync(join(rc, ".zshrc"), `sleep 2\nprintf ready > ${shellQuote(ready)}\n`);
      const created = herdr("tab", "create", "--workspace", env.workspaceId, "--cwd", env.dir,
        "--env", "ZDOTDIR=" + rc, "--label", "slow-shell", "--no-focus");
      const pane = created.root_pane.pane_id;
      env.surfaces.push(pane);
      await waitForShellReady(pane, { timeoutMs: 8000 });
      assert.ok(existsSync(ready), "must not declare readiness before the isolated rc finishes");
    } finally { cleanupTestEnv(env); }
  });

  it("chooses each auto split from the owned caller and reports metadata", { timeout: 30_000 }, async () => {
    const env = createTestEnv("herdr");
    const previousPane = process.env.HERDR_PANE_ID;
    try {
      const parent = herdr("pane", "list", "--workspace", env.workspaceId).panes[0].pane_id;
      process.env.HERDR_PANE_ID = parent;
      for (let i = 0; i < 2; i++) {
        const before = await getPaneLayout(parent);
        const expected = resolveAutoSplitDirection(before, parent);
        const pane = await createSubagentSurfaceAsync(`auto-${i}`, "auto", env.dir);
        env.surfaces.push(pane);
        const after = await getPaneLayout(parent);
        const root = after.panes.find((p) => p.pane_id === parent)!.rect as any;
        const child = after.panes.find((p) => p.pane_id === pane)!.rect as any;
        assert.equal(expected === "right" ? child.x > root.x : child.y > root.y, true);
        assert.equal(herdr("pane", "get", pane).pane.workspace_id, env.workspaceId);
      }
      await reportHerdrPaneMetadataAsync(parent, { subagents: 2, seq: 1 });
      const snapshot = JSON.stringify(herdr("pane", "get", parent));
      assert.match(snapshot, /subagents/);
      assert.match(snapshot, /2 running/);
      await reportHerdrPaneMetadataAsync(parent, { subagents: 0, seq: 2 });
      assert.doesNotMatch(JSON.stringify(herdr("pane", "get", parent)), /2 running/);
    } finally {
      if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = previousPane;
      cleanupTestEnv(env);
    }
  });
});
