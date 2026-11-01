import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isShellIdle, __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

import { slugifyName, toHerdrAgentName } from "../pi-extension/subagents/names.ts";

describe("subagent names", () => {
  it("preserves artifact slugs and uses a safe fallback", () => {
    assert.equal(slugifyName(" -- Hello,  World! -- "), "hello-world");
    assert.equal(slugifyName("🌏", "resume"), "resume");
  });
  it("generates valid bounded Herdr names with optional collision suffixes", () => {
    for (const name of ["", "🌏", "123 worker", "X".repeat(90), "_UP_PER--CASE_ "]) {
      for (const id of [undefined, "abcdef12"]) {
        const value = toHerdrAgentName(name, id);
        assert.match(value, /^[a-z][a-z0-9_-]{0,31}$/);
        if (id) assert.ok(value.endsWith("-abcd"));
      }
    }
  });
});

import { waitForShellReady, parseSubagentLayout, resolveAutoSplitDirection } from "../pi-extension/subagents/terminal.ts";

describe("shell readiness", () => {
  const idle = { shell_pid: 42, foreground_process_group_id: 42, foreground_processes: [{ pid: 42 }] };
  const busy = { ...idle, foreground_processes: [{ pid: 42 }, { pid: 43 }] };
  it("requires the shell alone in the foreground", () => {
    assert.equal(isShellIdle(idle), true);
    assert.equal(isShellIdle(busy), false);
    assert.equal(isShellIdle({ ...idle, foreground_process_group_id: 43 }), false);
    assert.equal(isShellIdle({ ...idle, foreground_processes: [] }), false);
  });
  it("waits for two consecutive idle samples, settle time and configured floor", async () => {
    let now = 0;
    const samples = [idle, busy, idle, idle];
    await waitForShellReady("w1:p2", {}, {
      inspect: async () => samples.shift()!, now: () => now,
      delay: async (ms) => { now += ms; }, env: { PI_SUBAGENT_SHELL_READY_DELAY_MS: "2500" },
    });
    assert.equal(samples.length, 0);
    assert.equal(now, 2500);
  });
  it("falls back for unsupported servers and refuses a known busy shell on timeout", async () => {
    let now = 0;
    const deps = { now: () => now, delay: async (ms: number) => { now += ms; }, env: {} };
    await waitForShellReady("w1:p2", {}, { ...deps, inspect: async () => { throw Error("unknown command"); } });
    assert.equal(now, 500);
    now = 0;
    await assert.rejects(waitForShellReady("w1:p2", { timeoutMs: 150 }, { ...deps, inspect: async () => busy }), /command not submitted/);
    assert.equal(now, 150);
  });
});

describe("automatic split geometry", () => {
  it("selects the caller rectangle, handles wide/tall panes and missing layouts", () => {
    assert.equal(parseSubagentLayout("split:auto"), "auto");
    const layout = { panes: [
      { pane_id: "wide", rect: { width: 150, height: 50 } },
      { pane_id: "tall", rect: { width: 75, height: 50 } },
    ] };
    assert.equal(resolveAutoSplitDirection(layout, "wide"), "right");
    assert.equal(resolveAutoSplitDirection(layout, "tall"), "down");
    assert.equal(resolveAutoSplitDirection(layout, "missing"), "right");
  });
});

describe("herdr surface arguments", () => {
  it("preserves the explicit child cwd and never steals focus", () => {
    const cwd = "/projects/child with spaces";
    for (const args of [
      __herdrTest__.buildTabCreateArgs("child", cwd, "w1"),
      __herdrTest__.buildPaneSplitArgs("w1:p1", "right", cwd),
    ]) {
      assert.equal(args[args.indexOf("--cwd") + 1], cwd);
      assert.ok(args.includes("--no-focus"));
    }
  });
});
