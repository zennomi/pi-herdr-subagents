import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

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
