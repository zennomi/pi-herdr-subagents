import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notifyHerdrCompletion, sendHerdrEscapeAsync, isShellIdle, __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

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
    const samples = [idle, busy, idle, idle, idle];
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

describe("agent-aware interrupt", () => {
  it("uses agent keys and only falls back for explicit unsupported/no-agent errors", async () => {
    const calls: string[][] = [];
    await sendHerdrEscapeAsync("w1:p2", async (args) => {
      calls.push(args);
      if (args[0] === "agent") throw { stderr: JSON.stringify({ error: { code: "agent_not_found" } }) };
      return "";
    });
    assert.deepEqual(calls, [["agent", "send-keys", "w1:p2", "esc"], ["pane", "send-keys", "w1:p2", "Escape"]]);
    let attempts = 0;
    await assert.rejects(sendHerdrEscapeAsync("w1:p2", async () => { attempts++; throw Error("timeout"); }));
    assert.equal(attempts, 1);
  });
});

describe("pane metadata", () => {
  it("isolates its source, normalizes tasks and expires parent counts", () => {
    const args = __herdrTest__.buildPaneMetadataArgs("w1:p1", { task: "line1\nline2", displayAgent: "pi · scout", subagents: 2, seq: 99 });
    assert.ok(args.includes("pi-herdr-subagents"));
    assert.ok(args.includes("task=line1 line2"));
    assert.ok(args.includes("pi · scout"));
    assert.ok(args.includes("subagents=2 running"));
    assert.equal(args[args.indexOf("--ttl-ms") + 1], "120000");
    assert.equal(args[args.indexOf("--seq") + 1], "99");
    const clear = __herdrTest__.buildPaneMetadataArgs("w1:p1", { subagents: 0, seq: 100 });
    assert.ok(clear.includes("--clear-token"));
    assert.ok(!clear.includes("--token"));
  });
});

describe("completion notifications", () => {
  it("only notifies an explicitly unfocused parent, once, with bounded content", async () => {
    for (const focused of [true, false, undefined]) {
      const calls: string[][] = [];
      await notifyHerdrCompletion("w1:p1", "Scout", "completed", "x".repeat(160) + "\nprivate second line", async (args) => {
        calls.push(args);
        return JSON.stringify({ result: { pane: { pane_id: "w1:p1", focused } } });
      });
      assert.equal(calls.length, focused === false ? 2 : 1);
      if (focused === false) {
        assert.deepEqual(calls[1], ["notification", "show", "Scout completed", "--body", "x".repeat(120), "--sound", "done"]);
      }
    }
    await notifyHerdrCompletion("w1:p1", "Scout", "failed", "error", async () => { throw Error("offline"); });
  });
});

describe("pane session observations", () => {
  it("parses valid references and ignores malformed optional session data", () => {
    const parse = (agent_session: unknown) => __herdrTest__.parsePaneGetOutput(JSON.stringify({ result: { pane: { pane_id: "w1:p2", agent: "pi", agent_status: "working", agent_session } } }), "w1:p2");
    const session = { kind: "path", value: "/child.jsonl", agent: "pi" };
    assert.deepEqual((parse(session) as any).agentSession, session);
    for (const invalid of [null, {}, { kind: "path", value: 123 }, { kind: "unknown", value: "abc" }]) {
      assert.equal((parse(invalid) as any).agentSession, undefined);
    }
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
