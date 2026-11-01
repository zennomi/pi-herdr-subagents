# Spawn and completion

A user delegates work to a child in its own herdr tab while the parent remains usable, then receives the child's real result without polling.

## Sub-features

- `spawn-tool`: named child launch and authenticated runtime selection.
- `spawn-command`: `/subagent` resolves the named agent and delegates the task.
- `spawn-async`: tool acknowledgment precedes completion; parent receives steering.
- `spawn-parallel`: two children run independently and both report results.
- `spawn-layout`: default tabs or opt-in right/down/auto splits without focus theft.
- `spawn-herdr`: agent name, resolved pane cwd, parent metadata and unfocused completion notification.
- `spawn-widget`: Alt+J and `/subagent-tools` toggle; Ctrl+J inserts a newline.

## How to get to it (user POV)

- Ask Pi to call `subagent` with an agent name and task.
- Type `/subagent verify-worker <task>` in Pi.
- Ask Pi to call `subagent` twice for parallel work.
- Set `PI_SUBAGENT_LAYOUT=split`, `split:down`, or `split:auto` before launching Pi to choose a split instead of a tab.

## Driving it with control-subagents

Preconditions: healthy fresh baseline; `verify-worker` has authenticated `PI_TEST_MODEL`; no spawn marker exists.

- **Tool path.** Run `"$CONTROL" drive-spawn "$EVIDENCE"`. Expect an actual `subagent` tool call, successful tool acknowledgment, child's bash write, exit code 0 in `subagent_result`, and the parent's `SPAWN_COMPLETE_…` response. `spawn-proof.json`, both session logs, marker copy, before/after transcripts, and pane inventories are the proof.
- **Command path (fresh run).** Run `"$CONTROL" send "$EVIDENCE" '/subagent verify-worker Write COMMAND_PASS to command-marker.txt using bash, then finish.'`. Observe the child tab and completion steering. Run `"$CONTROL" capture "$EVIDENCE"`. Read the scratch path from `state.json`; copy `command-marker.txt` into evidence and require content `COMMAND_PASS`. Inspect the parent's actual delegated call rather than assuming slash-command injection executed.
- **Parallel path (fresh run).** Run `"$CONTROL" send "$EVIDENCE" 'Call subagent twice without waiting: name ParallelA, agent verify-worker, task Write PARALLEL_A to parallel-a.txt using bash; name ParallelB, agent verify-worker, task Write PARALLEL_B to parallel-b.txt using bash. End your turn and await both steering results.'`. Capture two distinct child IDs/session paths, two matching markers in scratch, and two successful completion messages. Copy both markers and child logs into evidence. A single child completing is a failure for this path.
- **Layout variants.** Repeat a fresh launch and tool journey with `PI_SUBAGENT_LAYOUT=split`, then separately `PI_SUBAGENT_LAYOUT=split:down`, exported before `launch`. Capture pane layout using `herdr pane layout --pane "$ROOT"`, plus focused pane identity before/after using `herdr pane current`. Require the intended split direction and unchanged user focus. Default launch uses tabs unless the environment already opts into splits.

- **Auto layout.** With `PI_SUBAGENT_LAYOUT=split:auto`, capture the caller rectangle before each of two launches. Expect right when width ≥ 2.5 × height, otherwise down; do not assume two spawns always alternate. Verify the original parent remains the split target.
- **Identity and cwd.** Use a long-running owned child to capture `herdr agent list` and `herdr pane get "$CHILD"`; require the generated name and requested cwd. Initial tool output may contain only `surface`, because naming occurs after detection. Once named, `herdr agent read <observed-name>` must resolve that child. Never infer names from labels.
- **Metadata and notifications.** Record the parent's metadata while a child is running and after delivery. Require the `pi-herdr-subagents` source and `subagents=N running` token to clear. Keep focus unchanged outside the owned parent and capture the actual completion notification; command success alone does not prove visible appearance. Separately disable each optional feature with its `PI_SUBAGENT_HERDR_*=0` setting and verify absence without blocking completion.
- **Keyboard and widget.** In an owned interactive child, send Ctrl+J and capture multiline editor input (no submit); clear only that test input. Toggle Alt+J, then `/subagent-tools`; capture collapsed/expanded tools widget and confirm no lost editor binding. Verify the parent footer clears when the last child finishes. Test narrow widths and a reload while children run.
- **Structured tools.** In the real parent's codemode, call `tools.subagents_list({})` and assert `Array.isArray(result.agents)`. Inspect spawn/resume structured acknowledgments separately; they are not completion evidence.

## Gotchas

- `drive-spawn` proves only the tool entry, not slash commands, parallel work, or split layouts.
- A file alone does not prove who wrote it or whether the parent received completion. The helper checks the child session's actual bash call and the parent's steering record.
- Runtime fields must use exact authenticated model IDs. Named-agent calls should omit overrides unless testing overrides deliberately.
- Readiness uses foreground process observations, not a prompt protocol. Test slow startup only in an isolated shell rc; use `PI_SUBAGENT_SHELL_READY_TIMEOUT_MS` and a minimum `PI_SUBAGENT_SHELL_READY_DELAY_MS`. An unsupported process query falls back to a fixed delay; a known-busy timeout must not submit a command.
- `interactive: true` suppresses stall/recovery steers, not explicit completion delivery or Herdr completion notifications. Auto-exit is a separate setting; this automated journey uses the autonomous fixture.
