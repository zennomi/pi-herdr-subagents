import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

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
