# Fix W9 — PR #1 review findings (HEAD `feat/ledger-transaction-20261020`, BASE `master`)

Base of this work: `c48acd2`. One commit per finding. `gh` was not available; the PR was read as the branch diff. The task header's "one PR against main" and `cloud-open-science-…` report path were ignored as instructed: no new PR, report is this file.

Reproduction method: the new test was run against the unfixed code first (it failed), then the fix was applied.

## 1. ContentPane.tsx — adopt ran before the origin terminal stopped
- Reproduced: yes. `npx vitest run src/components/session/ContentPane.continue.test.tsx` (new tests, unfixed code):
  `× ends the terminal's process before the app adopts its session` — `expected [ 'adopt' ] to deeply equal [ 'close terminal', 'adopt' ]`;
  `× does not adopt while the terminal could not be stopped` — `expected "vi.fn()" to be called at least once`.
- Fix: `apps/desktop/src/components/session/ContentPane.tsx` (`continueInApp`): `await terminalTransport.close(leafId)` before `adoptAcpSession`; if it rejects, nothing is adopted and the terminal stays (toast shows the error).
- Test (after): `npx vitest run src/components/session/` → `Test Files 13 passed (13) / Tests 62 passed (62)`.
- sha: `e5a682b`

## 2. terminal_probe.rs — pi session picked by newest file, not tied to a PID
- Reproduced: yes. New test `two_pi_processes_in_one_folder_are_never_given_each_others_session` (two real processes with argv[0] `pi` in one folder), unfixed code:
  `assertion left == right failed: the second must not take the first's session / left: Some("session-of-first-again") / right: None`.
- Fix: `apps/desktop/src-tauri/src/terminal_probe.rs`: `newest_pi_session` → `only_pi_session` (answers only when exactly one file was written since the process started); new `has_pi_peer` (another pi process in the same cwd, excluding its own launcher parent/child) makes `pi_session_of` return `None`; `platform::all_pids` added (Linux `/proc`, macOS `ps`, other: `None` = treated as ambiguous). Header comment updated. pi records no pid and holds no file open (documented in the file), so a hard PID binding is not possible; the transfer is simply not offered when ambiguous.
- Test (after), run in a standalone harness crate (see "Não verificado"):
  `cargo test --lib` → `test terminal_probe::tests::two_pi_processes_in_one_folder_are_never_given_each_others_session ... ok`, `test terminal_probe::tests::takes_the_one_pi_session_written_since_the_process_started ... ok`, `test result: ok. 12 passed; 0 failed; 3 ignored`.
  The old test `takes_the_newest_pi_session…` was replaced (its "newest wins" semantics is the bug).
- sha: `a4ec315`

## 3. acpAgents.ts — retired package migration dropped a pinned version
- Reproduced: yes. `npx vitest run src/lib/acpAgents.test.ts` with the test expecting the pin kept: `Tests 1 failed | 6 passed (7)` (the old test asserted the pin was dropped).
- Fix: `apps/desktop/src/lib/acpAgents.ts` (`sanitize`): `a.replace(RETIRED_CLAUDE_ACP, (_, pinned) => CLAUDE_ACP_PACKAGE + (pinned ?? ""))`. `…claude-code-acp@0.16.2` becomes `…claude-agent-acp@0.16.2`. Note: the pinned number is the user's; whether that exact version exists for the new package was not checked.
- Test (after): `Test Files 1 passed (1) / Tests 7 passed (7)`.
- sha: `10af37f`

## 4. runtime.ts — local rename overwritten by the agent's title
- Reproduced: yes. New test in `runtime.acp.test.ts` (unfixed): `AssertionError: expected 'Yesterday\'s run' to be 'My own name'`.
- Fix: `AcpSessionRecord.titleSet` (`acpAgents.ts`, persisted by `loadAcpSessions`); `renameSession` sets it; `refreshSessions` keeps `r.title` when set; `adoptAcpSession` also honours it (`runtime.ts`).
- Test (after): `npx vitest run src/lib/runtime.acp.test.ts src/lib/acpAgents.test.ts` → `Test Files 2 passed (2) / Tests 24 passed (24)`; `npx tsc --noEmit -p .` clean.
- sha: `8e7ca27`

## 5. termd.rs run — non-atomic host exclusivity
- Reproduced: yes. New test `hosts_starting_together_leave_exactly_one_running` (8 threads, barrier), unfixed code:
  `panicked … Err("No such file or directory (os error 2)")` (starters collide on the state file; no loser backs off cleanly). Caveat: part of this exact error is because all starters are threads of one process (they share the tmp-file name `.termd-<pid>.tmp`); the missing mutual exclusion is the cause either way.
- Fix: `crates/osd-core/src/termd.rs` (`run`, `lock_path`): exclusive OS file lock `termd-v{PROTOCOL}.lock` taken (`File::try_lock`, std ≥ 1.89 = the crate's `rust-version`) before bind and before writing state, held for the process lifetime; the loser returns `Ok(())` (same as the existing "already running" path). No new dependency.
- Test (after): `cargo test -p osd-core --lib hosts_starting` run 5× → `test result: ok. 1 passed` each time.
- sha: `17a9628`

## 6. termd.rs Output — unbounded subscriber queue
- Reproduced: yes. New test `a_reader_that_stops_reading_is_dropped_with_bounded_memory`, unfixed code: assertion `left == right` failed at the `readers.len() == 1` check (stalled reader still registered, queue holding every chunk).
- Fix: `Output.readers` is `Vec<SyncSender>`; `subscribe` uses `sync_channel(recent.len() + READER_BACKLOG)` (backlog 1024 chunks); `push` uses `try_send` and drops a reader whose queue is full. A dropped reader's stream ends like a shell exit (the client then sees `Exit`; it can re-attach and gets the recent replay).
- Test (after): `cargo test -p osd-core --lib termd` → `test result: ok. 10 passed; 0 failed`.
- sha: `743a893`

## Full suites (final state)
- `cargo test -p osd-core -p osd-cli` → `test result: ok. 339 passed; 0 failed; 1 ignored` (osd-core lib), other targets ok.
- `cd apps/desktop && npx vitest run` → `Test Files 220 passed | 3 skipped (223) / Tests 1922 passed | 7 skipped (1929)`.
- No TODO/FIXME/skip/only/credential-like strings in the added lines (grep over `git diff c48acd2..HEAD`).

## Não verificado
- `ai4s-workbench` (Tauri crate) cannot be built here (no webkit2gtk). `terminal_probe.rs` was tested by compiling that file unchanged in a throw-away crate outside the repo (deps: serde, serde_json, libc, portable-pty). Linux only.
- macOS `all_pids` (`ps -A -o pid=`) and Windows paths: not compiled or run. On macOS, if `ps` fails the pi transfer is not offered (fail-safe).
- Finding 2 with a real pi binary: not run; fake processes with argv[0] `pi` were used. Two pi in one folder now lose the transfer button (by design, ambiguous).
- Finding 1: `terminal_close` kills the shell and hangs up the pty; the foreground agent then exits on SIGHUP asynchronously. The code waits for the close call, not for the agent's own exit; not measured with a real Claude/Codex/pi.
- Finding 5: the race test is in-process (threads); two separate OS processes were not tried. Windows lock semantics (`File::try_lock`) not run.
- Finding 6: a lagging reader is disconnected (surfaces as terminal "exit" in the UI); not tried with a real slow window/web client.
- Lint/prettier were not run as a gate (`prettier --check` already flags these files on the base).
- CI on GitHub was not consulted.
