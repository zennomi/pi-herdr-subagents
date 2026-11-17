import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Fake CLIs only: no real Herdr server, Pi session, or model is contacted. */
function withBackend(env: Record<string, string>, source: string) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-backend-unit-"));
  try {
    const cli = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const bin = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ bin, args }) + '\\n');
const emit = value => console.log(JSON.stringify(value));
if (bin === 'ps') {
  if (process.env.NO_OWNER) process.exit(1);
  console.log(process.ppid + ' 42\\n42 43\\n43 0');
} else if (bin === 'herdr') {
  if (args[0] === 'workspace' && args[1] === 'list') emit({ result: { workspaces: [{ workspace_id: 'workspace-1' }] } });
  else if (args[0] === 'tab' && args[1] === 'create') emit({ result: { root_pane: { pane_id: 'tui-child' } } });
  else if (args[1] === 'current') emit({ result: {} });
  else if (args[1] === 'process-info') emit({ result: { process_info: { shell_pid: 42, foreground_process_group_id: 42, foreground_processes: [{ pid: 42 }] } } });
  else emit({});
} else {
  if (args[0] === '--version') console.log('mock core');
  else if (args[0] === 'ls') emit([]);
  else if (args[0] === 'run') emit({ address: 'core-child', state: 'live' });
  else if (args[0] === 'get') emit({ address: args[1], state: 'live', pid: 43 });
  else emit({});
}
`;
    for (const bin of ["herdr", "hc", "herdr-core", "ps"]) writeFileSync(join(dir, bin), cli, { mode: 0o755 });
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (/^(HERDR_|HC_|PI_SUBAGENT_)/.test(key)) delete cleanEnv[key];
    }
    const scriptPath = join(dir, "launch.sh");
    const logPath = join(dir, "calls.jsonl");
    writeFileSync(logPath, "");
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import * as terminal from './pi-extension/subagents/terminal.ts';
      import { getSubagentConfig } from './pi-extension/subagents/config.ts';
      const scriptPath = ${JSON.stringify(scriptPath)};
      ${source}
    `], {
      cwd: root, encoding: "utf8", timeout: 10000,
      env: { ...cleanEnv, PATH: `${dir}:${dirname(process.execPath)}`, CALL_LOG: logPath, ...env },
    });
    return {
      calls: readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
      script: (() => { try { return readFileSync(scriptPath, "utf8"); } catch { return ""; } })(),
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("terminal backend merge contracts (fake CLI)", () => {
  for (const [name, env, kind] of [
    ["TUI host", { HERDR_ENV: "1" }, "herdr-tui"],
    ["core host", { HC_TERMINAL_ID: "core-parent" }, "herdr-core"],
    ["nearest inherited owner", { HERDR_ENV: "1", HERDR_PANE_ID: "tui-parent", HC_TERMINAL_ID: "core-parent" }, "herdr-tui"],
    ["unresolved ownership fallback", { HERDR_ENV: "1", HERDR_PANE_ID: "tui-parent", HC_TERMINAL_ID: "core-parent", NO_OWNER: "1" }, "herdr-core"],
    ["explicit override", { HERDR_ENV: "1", HC_TERMINAL_ID: "core-parent", PI_SUBAGENT_BACKEND: "herdr-tui" }, "herdr-tui"],
  ] as const) {
    it(`selects ${name} and pins selection`, () => {
      withBackend(env, `
        assert.equal(terminal.getTerminalBackend().kind, ${JSON.stringify(kind)});
        process.env.PI_SUBAGENT_BACKEND = 'invalid-after-selection';
        assert.equal(terminal.getTerminalBackend().kind, ${JSON.stringify(kind)});
        assert.equal(terminal.isTerminalAvailable(), true);
      `);
    });
  }

  it("rejects invalid backend overrides", () => {
    withBackend({ PI_SUBAGENT_BACKEND: "typo" }, `
      assert.equal(terminal.isTerminalAvailable(), false);
      assert.match(terminal.terminalSetupHint(), /Cannot select terminal backend/);
    `);
  });

  for (const kind of ["herdr-tui", "herdr-core"]) {
    it(`${kind}: requires explicit outside-host opt-in`, () => {
      withBackend({ PI_SUBAGENT_BACKEND: kind }, "assert.equal(terminal.isTerminalAvailable(), false);");
      withBackend({ PI_SUBAGENT_BACKEND: kind }, `
        getSubagentConfig().environment.allowOutsideHerdr = true;
        assert.equal(terminal.isTerminalAvailable(), true);
      `);
    });
  }

  it("core launches the prepared script once with child-local identity and routes cleanup", () => {
    const { calls, script } = withBackend({ HC_TERMINAL_ID: "core-parent" }, `
      const surface = await terminal.launchSubagentTerminal({
        name: 'worker', task: 'task', cwd: '/child cwd', layout: 'auto',
        command: 'echo task', scriptPath,
      });
      assert.equal(surface, 'core-child');
      await terminal.interruptPaneAsync(surface);
      await terminal.closePaneAsync(surface);
    `);
    const runs = calls.filter(({ args }) => args[0] === "run");
    assert.equal(runs.length, 1);
    for (const flag of ["--bg", "--no-notify", "--no-parent", "--outlive-parent"]) assert.ok(runs[0].args.includes(flag));
    assert.ok(runs[0].args.includes("/child cwd"));
    assert.match(script, /export PI_SUBAGENT_BACKEND='herdr-core'/);
    assert.match(script, /export PI_SUBAGENT_SURFACE="\$HC_TERMINAL_ID"/);
    assert.ok(calls.some(({ args }) => args.join(" ") === "keys core-child esc"));
    assert.ok(calls.some(({ args }) => args.join(" ") === "kill core-child"));
    assert.ok(calls.some(({ args }) => args.join(" ") === "rm core-child"));
    assert.ok(calls.every(({ bin }) => bin !== "herdr"));
  });

  it("TUI outside-host async splits fall back to a tab in the resolved workspace", () => {
    const { calls, script } = withBackend({ PI_SUBAGENT_BACKEND: "herdr-tui" }, `
      getSubagentConfig().environment.allowOutsideHerdr = true;
      const surface = await terminal.createSubagentSurfaceAsync('worker', 'auto', '/child cwd');
      assert.equal(surface, 'tui-child');
      await terminal.waitForShellReady(surface);
      await terminal.runScriptInPaneAsync(surface, 'echo task', { scriptPath });
    `);
    const create = calls.find(({ args }) => args[0] === "tab" && args[1] === "create");
    assert.ok(create.args.includes("workspace-1"));
    assert.ok(create.args.includes("/child cwd"));
    assert.ok(create.args.includes("--no-focus"));
    assert.equal(calls.filter(({ args }) => args[0] === "pane" && args[1] === "run").length, 1);
    assert.match(script, /export PI_SUBAGENT_BACKEND='herdr-tui'/);
  });
});
