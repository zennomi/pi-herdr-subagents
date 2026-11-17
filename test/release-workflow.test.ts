import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("release workflow runs only in the upstream repository, including manual dispatch", async () => {
  const workflow = await readFile(".github/workflows/publish.yml", "utf8");

  assert.match(workflow, /  detect:\n    name: Detect version bump\n    if: github\.repository == '0xRichardH\/pi-herdr-subagents'\n/);
  assert.match(workflow, /  release:\n    name: [^\n]+\n    needs: detect\n    if: needs\.detect\.outputs\.release == 'true'\n/);
});

test("release workflow reacts to package version changes and creates all release artifacts", async () => {
  const workflow = await readFile(".github/workflows/publish.yml", "utf8");

  assert.match(workflow, /branches:\n\s+- main/);
  assert.match(workflow, /paths:\n\s+- package\.json/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /git tag -a "\$TAG"/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.match(workflow, /gh release create "\$TAG"/);
  assert.match(workflow, /--generate-notes/);
  assert.match(workflow, /npmjs\.com\/package\/pi-herdr-subagents\/v\/\$\{VERSION\}/);
});
