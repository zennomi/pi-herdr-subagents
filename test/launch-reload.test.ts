import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import extension, { __test__ } from "../pi-extension/subagents/index.ts";
import { getHarnessDriver } from "../pi-extension/subagents/harness/index.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const assistantEntry = (text: string) => JSON.stringify({
  type: "message", message: { role: "assistant", content: [{ type: "text", text }] },
}) + "\n";

/** All external effects are injected; tools, watchers and lifecycle hooks are real. */
async function withHarness(run: (h: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-launch-reload-"));
  const env = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_ID", "PI_DENY_TOOLS", "PI_SUBAGENT_HERDR_METADATA", "PI_SUBAGENT_HERDR_AGENT_NAME"];
  const savedEnv = env.map((key) => process.env[key]);
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_DENY_TOOLS;
  process.env.PI_SUBAGENT_HERDR_METADATA = "0";
  process.env.PI_SUBAGENT_HERDR_AGENT_NAME = "0";
  const parentFile = join(dir, "parent.jsonl");
  writeFileSync(parentFile, assistantEntry("old output"));
  const completion = deferred<any>();
  const calls = { created: [] as string[], submitted: [] as string[], closed: [] as string[], watched: 0 };
  const model = { provider: "launch-test", id: "model", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100 };
  const ctx: any = {
    cwd: dir, mode: "json", hasUI: false, model, scopedModels: [],
    modelRegistry: { find: () => model, getAvailable: () => [model], getAll: () => [model], hasConfiguredAuth: () => true },
    sessionManager: { getSessionFile: () => parentFile, getSessionDir: () => dir, getSessionId: () => "parent" },
  };
  const deps: any = {
    isTerminalAvailable: () => true,
    createSubagentSurfaceAsync: async () => { calls.created.push("owned-pane"); return "owned-pane"; },
    setPaneTaskAsync: async () => {},
    waitForShellReady: async () => {},
    runScriptInPaneAsync: async (surface: string) => { calls.submitted.push(surface); return "script.sh"; },
    closePaneAsync: async (surface: string) => { calls.closed.push(surface); },
    waitForCompletion: async (signal: AbortSignal) => {
      calls.watched++;
      signal.addEventListener("abort", () => completion.reject(new Error("aborted")), { once: true });
      return completion.promise;
    },
  };
  const apis: any[] = [];
  function load(overrides = {}, factory = extension) {
    const events = new Map<string, Function>();
    const tools = new Map<string, any>();
    const messages: any[] = [];
    const api: any = {
      on: (event: string, handler: Function) => events.set(event, handler),
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand() {}, registerMessageRenderer() {},
      getThinkingLevel: () => "off",
      sendMessage: (message: any, options: any) => { messages.push({ message, options }); },
    };
    factory(api, { ...deps, ...overrides });
    const loaded = {
      api, tools, messages,
      start: () => events.get("session_start")!({ reason: "reload" }, ctx),
      shutdown: (reason: string) => events.get("session_shutdown")!({ reason }, ctx),
      launch: (kind: string) => {
        const tool = tools.get(kind === "resume" ? "subagent_resume" : "subagent");
        const params = kind === "resume" ? { sessionPath: parentFile, name: "Test", message: "follow up" }
          : { name: "Test", task: "test task", model: "launch-test/model" };
        return tool.execute("call", params, undefined, undefined, ctx);
      },
    };
    apis.push(loaded);
    return loaded;
  }
  try {
    assert.equal(__test__.runningSubagents.size, 0);
    await run({ dir, ctx, parentFile, deps, calls, completion, load });
  } finally {
    const watchers = Array.from(__test__.runningSubagents.values(), (running) => running.watcher);
    apis.at(-1)?.shutdown("quit");
    await Promise.all(watchers);
    for (const cleanup of __test__.runtime.paneCleanups?.values() ?? []) {
      if (cleanup.retry) clearTimeout(cleanup.retry);
      await cleanup.pending;
    }
    __test__.runtime.paneCleanups?.clear();
    env.forEach((key, index) => {
      if (savedEnv[index] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[index];
    });
    rmSync(dir, { recursive: true, force: true });
  }
}

function runningFrom(result: any) {
  const running = __test__.runningSubagents.get(result.structuredContent.id)!;
  assert.ok(running, "successful launches must already have a supervised registry entry");
  assert.ok(running.watcher);
  return running;
}

function complete(h: any, running: any, ping = false) {
  appendFileSync(running.sessionFile, assistantEntry("new output"));
  h.completion.resolve({ reason: ping ? "ping" : "done", exitCode: 0,
    ...(ping ? { ping: { name: "Test", message: "help me" } } : {}) });
  return running.watcher;
}

describe("owned launch transactions (registered spawn and resume tools)", () => {
  for (const kind of ["spawn", "resume"]) {
    for (const failure of ["task", "readiness", "build/write", "script write", "uncertain submission"]) {
      it(`${kind}: closes the pane after ${failure} failure without resubmission`, async () => {
        await withHarness(async (h) => {
          const fail = () => { throw new Error(`${failure} failed`); };
          const overrides: any = {};
          if (failure === "task") overrides.setPaneTaskAsync = fail;
          if (failure === "readiness") overrides.waitForShellReady = fail;
          if (failure === "build/write") {
            if (kind === "resume") overrides.writeFileSync = fail;
            else overrides.getHarnessDriver = () => Object.assign(Object.create(getHarnessDriver("pi")), { buildCommand: fail });
          }
          if (failure === "script write") overrides.runScriptInPaneAsync = fail;
          if (failure === "uncertain submission") overrides.runScriptInPaneAsync = async (surface: string) => {
            h.calls.submitted.push(surface); // Server may have accepted this command before timeout.
            throw new Error("uncertain submission failed");
          };
          const api = h.load(overrides);
          await api.start();
          await assert.rejects(api.launch(kind), new RegExp(`${failure} failed`));
          assert.deepEqual(h.calls.created, ["owned-pane"]);
          assert.deepEqual(h.calls.closed, ["owned-pane"]);
          assert.equal(h.calls.submitted.length, failure === "uncertain submission" ? 1 : 0);
          assert.equal(h.calls.watched, 0);
          assert.equal(__test__.runningSubagents.size, 0);
          assert.equal(api.messages.length, 0);
        });
      });
    }

    for (const boundary of ["create", "task", "readiness", "submission"]) {
      for (const reason of ["reload", "new", "quit"]) {
        it(`${kind}: ${reason} while awaiting ${boundary} cannot adopt a stale launch`, async () => {
          await withHarness(async (h) => {
            const entered = deferred();
            const release = deferred();
            const method = { create: "createSubagentSurfaceAsync", task: "setPaneTaskAsync",
              readiness: "waitForShellReady", submission: "runScriptInPaneAsync" }[boundary]!;
            const original = h.deps[method];
            const api = h.load({ [method]: async (...args: any[]) => {
              const value = await original(...args);
              entered.resolve();
              await release.promise;
              return value;
            } });
            await api.start();
            const rejected = assert.rejects(api.launch(kind), /parent session changed or reloaded/);
            await entered.promise;
            api.shutdown(reason);
            // Session methods from the old context must not be read after an await.
            h.ctx.sessionManager = { ...h.ctx.sessionManager, getSessionId: () => reason === "reload" ? "parent" : "different-parent" };
            const replacement = h.load();
            if (reason !== "quit") await replacement.start();
            release.resolve();
            await rejected;
            assert.deepEqual(h.calls.closed, ["owned-pane"]);
            assert.equal(h.calls.submitted.length, boundary === "submission" ? 1 : 0);
            assert.equal(h.calls.watched, 0);
            assert.equal(__test__.runningSubagents.size, 0);
            assert.equal(replacement.messages.length, 0);
          });
        });
      }
    }

    it(`${kind}: failed close remains supervised across reload and retries only cleanup`, async (t) => {
      await withHarness(async (h) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let closes = 0;
        const api = h.load({
          runScriptInPaneAsync: async (surface: string) => { h.calls.submitted.push(surface); throw new Error("timeout"); },
          closePaneAsync: async (surface: string) => {
            h.calls.closed.push(surface);
            if (++closes === 1) throw new Error("close timeout");
          },
        });
        await api.start();
        await assert.rejects(api.launch(kind), /timeout/);
        assert.match(__test__.runtime.paneCleanups!.get("owned-pane")!.error!, /close timeout/);
        api.shutdown("reload");
        await h.load().start();
        t.mock.timers.tick(1000);
        await turn();
        assert.equal(__test__.runtime.paneCleanups!.size, 0);
        assert.deepEqual(h.calls.closed, ["owned-pane", "owned-pane"]);
        assert.deepEqual(h.calls.submitted, ["owned-pane"]);
      });
    });
  }
});

describe("watcher delivery across replacement runtimes", () => {
  for (const kind of ["spawn", "resume", "ping"]) {
    for (const gap of ["before factory", "before session_start"]) {
      it(`${kind}: retains completion ${gap}, then delivers exactly once to the ready replacement`, async () => {
        await withHarness(async (h) => {
          const old = h.load();
          await old.start();
          const result = await old.launch(kind);
          assert.ok(Value.Check(old.tools.get(kind === "resume" ? "subagent_resume" : "subagent").outputSchema, result.structuredContent));
          const running = runningFrom(result);
          old.shutdown("reload");
          old.api.sendMessage = () => { throw new Error("stale API must never be used"); };
          let replacement = gap === "before session_start" ? h.load() : undefined;
          await complete(h, running, kind === "ping");
          assert.equal(running.lifecycle.delivery, "pending");
          assert.equal(__test__.runningSubagents.get(running.id), running);
          assert.equal(running.pendingCompletion?.options.kind, kind === "resume" ? "resume" : "spawn");
          if (kind === "resume") assert.equal(running.pendingCompletion?.options.entryCountBefore, 1);
          assert.equal(running.deliveryError, undefined, "no stale/uninitialized send attempt");
          assert.equal(replacement?.messages.length ?? 0, 0);
          replacement ??= h.load();
          await replacement.start();
          await replacement.start();
          assert.equal(replacement.messages.length, 1);
          assert.match(replacement.messages[0].message.content, kind === "ping" ? /help me/ : /new output/);
          assert.deepEqual(replacement.messages[0].options, { triggerTurn: true, deliverAs: "steer" });
          assert.equal(running.lifecycle.delivery, "delivered");
          assert.equal(running.pendingCompletion, undefined);
          assert.equal(__test__.runningSubagents.size, 0);
          assert.deepEqual(h.calls.closed, ["owned-pane"]);
        });
      });
    }
  }

  for (const newOutput of [false, true]) {
    it(`resume notification matches delivery with new output=${newOutput}`, async () => {
      await withHarness(async (h) => {
        const notifications: any[] = [];
        const api = h.load({ notifyHerdrCompletion: async (...args: any[]) => { notifications.push(args); } });
        await api.start();
        const running = runningFrom(await api.launch("resume"));
        __test__.runtime.parentPane = "mock-parent";
        if (newOutput) appendFileSync(running.sessionFile, assistantEntry("resumed answer"));
        h.completion.resolve({ reason: "done", exitCode: 0 });
        await running.watcher;
        const expected = newOutput ? "resumed answer" : "Resumed session exited without new output";
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0][3], expected);
        assert.ok(api.messages[0].message.content.includes(expected));
        assert.ok(!api.messages[0].message.content.includes("old output"));
      });
    });
  }

  for (const failure of ["throw", "reject"]) {
    it(`contains sendMessage ${failure}, keeps the original result and only retries on a replacement API`, async () => {
      await withHarness(async (h) => {
        const old = h.load();
        await old.start();
        let attempts = 0;
        old.api.sendMessage = () => {
          attempts++;
          if (failure === "throw") throw new Error("send failed");
          return Promise.reject(new Error("send failed"));
        };
        const running = runningFrom(await old.launch("spawn"));
        await complete(h, running);
        await old.start();
        assert.equal(attempts, 1, "no fallback error send or same-API retries");
        assert.match(running.deliveryError!, /send failed/);
        assert.match(running.pendingCompletion!.result.summary, /new output/);
        assert.equal(running.lifecycle.delivery, "pending");
        old.shutdown("reload");
        const replacement = h.load();
        await replacement.start();
        assert.equal(replacement.messages.length, 1);
        assert.match(replacement.messages[0].message.content, /new output/);
        assert.equal(running.lifecycle.delivery, "delivered");
        assert.equal(__test__.runningSubagents.size, 0);
      });
    });
  }

  it("serializes delivery when replacement starts while the old send is still failing", async () => {
    await withHarness(async (h) => {
      const sending = deferred();
      const entered = deferred();
      const old = h.load();
      await old.start();
      old.api.sendMessage = () => { entered.resolve(); return sending.promise; };
      const running = runningFrom(await old.launch("resume"));
      const watching = complete(h, running);
      await entered.promise;
      old.shutdown("reload");
      const replacement = h.load();
      const starting = replacement.start();
      sending.reject(new Error("old send failed"));
      await Promise.all([watching, starting]);
      assert.equal(replacement.messages.length, 1);
      assert.equal(running.lifecycle.delivery, "delivered");
    });
  });

  it("does not redeliver a successful in-flight send when a replacement starts", async () => {
    await withHarness(async (h) => {
      const sending = deferred();
      const entered = deferred();
      const old = h.load();
      await old.start();
      let attempts = 0;
      old.api.sendMessage = () => { attempts++; entered.resolve(); return sending.promise; };
      const running = runningFrom(await old.launch("spawn"));
      const watching = complete(h, running);
      await entered.promise;
      old.shutdown("reload");
      const replacement = h.load();
      const starting = replacement.start();
      sending.resolve();
      await Promise.all([watching, starting]);
      assert.equal(attempts, 1);
      assert.equal(replacement.messages.length, 0);
      assert.equal(running.lifecycle.delivery, "delivered");
      assert.equal(__test__.runningSubagents.size, 0);
    });
  });

  it("adopts a pending result from an old module closure after an actual module reload", async () => {
    await withHarness(async (h) => {
      const old = h.load();
      await old.start();
      const running = runningFrom(await old.launch("resume"));
      old.shutdown("reload");
      const reloaded = await import("../pi-extension/subagents/index.ts?reload-regression");
      assert.equal(reloaded.__test__.runtime, __test__.runtime);
      const replacement = h.load({}, reloaded.default);
      await complete(h, running);
      assert.equal(replacement.messages.length, 0);
      await replacement.start();
      assert.equal(replacement.messages.length, 1);
      assert.match(replacement.messages[0].message.content, /new output/);
      assert.equal(running.lifecycle.delivery, "delivered");
    });
  });

  it("keeps failed watcher cleanup supervised without replacing or duplicating the result", async (t) => {
    await withHarness(async (h) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let closes = 0;
      const api = h.load({ closePaneAsync: async (surface: string) => {
        h.calls.closed.push(surface);
        if (++closes === 1) throw new Error("close failed");
      } });
      await api.start();
      const running = runningFrom(await api.launch("spawn"));
      await complete(h, running);
      assert.equal(running.lifecycle.delivery, "delivered");
      assert.equal(api.messages.length, 1);
      assert.match(api.messages[0].message.content, /new output/);
      assert.equal(__test__.runtime.paneCleanups!.size, 1);
      t.mock.timers.tick(1000);
      await turn();
      assert.equal(__test__.runtime.paneCleanups!.size, 0);
      assert.equal(api.messages.length, 1);
      assert.deepEqual(h.calls.closed, ["owned-pane", "owned-pane"]);
    });
  });

  for (const when of ["watching", "pending", "sending"]) {
    it(`true shutdown suppresses ${when} completion even after a new session starts`, async () => {
      await withHarness(async (h) => {
        const old = h.load();
        await old.start();
        const sending = deferred();
        const entered = deferred();
        if (when === "sending") old.api.sendMessage = () => { entered.resolve(); return sending.promise; };
        const running = runningFrom(await old.launch("spawn"));
        if (when === "pending") {
          old.shutdown("reload");
          await complete(h, running);
        } else if (when === "sending") {
          void complete(h, running);
          await entered.promise;
        }
        old.shutdown("new");
        h.ctx.sessionManager.getSessionId = () => "new-parent";
        const replacement = h.load();
        const starting = replacement.start();
        if (when === "sending") sending.reject(new Error("send cancelled"));
        await Promise.all([running.watcher, starting]);
        assert.equal(running.lifecycle.delivery, "suppressed");
        assert.equal(running.pendingCompletion, undefined);
        assert.equal(__test__.runningSubagents.size, 0);
        assert.equal(replacement.messages.length, 0);
        assert.deepEqual(h.calls.closed, ["owned-pane"]);
      });
    });
  }

  for (const failure of ["poll", "extract", "notify"]) {
    it(`contains ${failure} failure and cleans up without duplicate delivery`, async () => {
      await withHarness(async (h) => {
        const overrides: any = {};
        if (failure === "poll") overrides.waitForCompletion = async () => { throw new Error("poll failed"); };
        if (failure === "extract") overrides.getHarnessDriver = () => Object.assign(Object.create(getHarnessDriver("pi")), {
          extractResult: async () => { throw new Error("extract failed"); } });
        if (failure === "notify") overrides.notifyHerdrCompletion = async () => { throw new Error("notify failed"); };
        const api = h.load(overrides);
        await api.start();
        const result = await api.launch("spawn");
        // Poll failure may already have delivered by the time execute returns.
        if (failure !== "poll") {
          const running = runningFrom(result);
          if (failure === "notify") __test__.runtime.parentPane = "mock-parent";
          await complete(h, running);
        }
        await turn();
        assert.deepEqual(h.calls.closed, ["owned-pane"]);
        assert.equal(api.messages.length, 1);
        assert.equal(api.messages[0].message.details.exitCode, failure === "notify" ? 0 : 1);
        assert.equal(__test__.runningSubagents.size, 0);
      });
    });
  }
});
