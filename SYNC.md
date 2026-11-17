# Maintaining this fork

- **Fork / `origin`:** https://github.com/zennomi/pi-herdr-subagents
- **Upstream / `upstream`:** https://github.com/0xRichardH/pi-herdr-subagents

This fork keeps its own changes and merges upstream updates. Do not reset the
fork to upstream or use `gh repo sync --force`: that would discard fork-only
commits. Although GitHub's fork network originates at `HazAT/pi-interactive-subagents`,
the upstream maintained here is **`0xRichardH/pi-herdr-subagents`**.

## Set up a fresh clone

```bash
git clone git@github.com:zennomi/pi-herdr-subagents.git
cd pi-herdr-subagents
git remote add upstream git@github.com:0xRichardH/pi-herdr-subagents.git
git config remote.pushDefault origin
git config branch.main.pushRemote origin
git branch --set-upstream-to=origin/main main
gh repo set-default zennomi/pi-herdr-subagents # optional; requires GitHub CLI
```

Existing clones can check their configuration with `git remote -v` and
`git branch -vv`. Fetch upstream updates, but push changes only to `origin`.

## Sync upstream safely

Run each stage only after the preceding stage succeeds. Start with a clean working
tree (`git status --short` must be empty). Commit intentional changes first, or
stash local-only changes with `git stash push -u -m "before upstream sync"`.
Do not publish personal `.pi/settings.json` changes just to clear the working tree.

### 1. Fetch and create a sync branch

```bash
git fetch --all --prune
git switch main
git merge --ff-only origin/main
```

If the fast-forward is refused, stop and reconcile local and remote fork changes
with a normal merge; do not force-reset either history.

```bash
sync_branch="sync/upstream-$(date +%Y%m%d-%H%M%S)"
git switch -c "$sync_branch"
git merge upstream/main
```

If there are conflicts, preserve both fork customizations and applicable upstream
changes. Edit each conflicted file, stage only resolved files, then run
`git merge --continue`. To cancel an unfinished merge, use `git merge --abort`.
Do not proceed while `git status` still reports unresolved conflicts.

### 2. Verify

```bash
npm ci
npm run lint
npm test
node --test test/launch-reload.test.ts
```

These are automated regression checks, not live end-to-end verification. For
changes affecting real Pi/Herdr sessions, additionally follow
`.pi/skills/run-integration-tests/SKILL.md` in a suitable terminal environment.

### 3. Publish to your fork

After all required checks pass, either push the sync branch and open a PR into
`zennomi/pi-herdr-subagents:main`, or update `main` directly:

```bash
git switch main
git merge --ff-only "$sync_branch"
git push origin main
```

A rejected push means the remote advanced: fetch and merge the new fork changes,
rerun checks, and retry. **Never force-push to resolve a sync rejection.**

If you created a stash, restore that specific stash afterwards (`git stash list`,
then `git stash pop stash@{N}` with its actual index). Resolve any conflicts without
losing the local-only settings.

## Releases

The inherited npm release workflow is guarded to run only in
`0xRichardH/pi-herdr-subagents`. Syncing this fork must not publish the upstream
package or create automatic release tags. Publishing a separately named package
requires a deliberate package and release configuration change.
