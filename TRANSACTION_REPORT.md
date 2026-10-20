# Transactional local ledger v1 — isolated implementation

Task `task_cf56ca67b625`, dispatch `ctx_26c65667bb86`.
Worktree: `/tmp/open-science-ledger-transaction-20261020`.
Branch: `codex/ledger-transaction-20261020`, base `060d827`.

## Result and activation boundary

Implemented a separate, explicit core API, `osd_core::ledger::migrate_v1(root)`.
It imports local JSONL into authoritative `.openscience/ledger-v1.sqlite` in
one transaction while holding the existing cross-process ledger lock. The
SQLite schema-version commit is the activation point. Run recording then
commits the run and all successful output-provenance links atomically; failed
runs retain their run snapshot without produced-output links. Duplicate retries
reuse the originally stored snapshot, not rescanned output files.

No workspace is activated automatically; no CLI activation command or desktop
toggle is included. The coordinator can integrate and review this isolated
implementation without switching installed applications or live workspaces.

## Compatibility and fail-closed behavior

- Both original JSONL files stay byte-for-byte unchanged, with their exact
  bytes (including absent versus empty) also retained inside SQLite.
- This is an explicitly staged incompatible switch: direct JSONL readers see
  only pre-activation history. There is no best-effort JSONL projection and
  therefore no projection crash/replay window to disguise as atomicity.
- Stop older/uncooperative local writers and adapt direct JSONL consumers
  before activation. Subsequent source-byte changes stop DB readers/writers
  with an error rather than silently discarding or merging changes.
- Built-in artifact History reads `versions_for`; list-runs calls
  `read_runs_checked`; paginated run-index sync reads local committed SQLite
  records and aborts queries on activation/migration/source errors. The
  disposable `runs.db` index is still not authoritative.
- The legacy public Vec-returning `read_runs` wrapper returns empty on an error;
  built-in Result-returning APIs propagate the error and do not fall back.
- `runtime/skills/core/traceability-review/SKILL.md` directly reads provenance
  JSONL. It now checks for the v1 DB and reports Check 3 unavailable instead of
  using frozen history or mtimes. Remote compute/modal writers only append
  `remote-runs.jsonl`; these remain outside this local transaction contract.
- Standalone run-link APIs and authored append calls that attempt to attach a
  run ID are rejected after activation; run recording owns atomic links.
- Import rejects malformed UTF-8/JSON, incomplete lines, duplicate run IDs and
  path/version pairs, invalid status/identity/path, orphan run links, and
  successful source runs lacking an output link. No tolerant skip on migration.
- Unknown schema versions and nonempty partial schemas require operator review.
  An interrupted migration with a rolled-back, empty version-zero DB can be
  retried explicitly through the migration API; readers fail closed meanwhile.

## Durability and limits

SQLite connections request `synchronous=FULL`; migration selects rollback
journaling (`journal_mode=DELETE`). A successful commit is required before a
write succeeds. Tests terminate a child process without Rust destructors during
an open migration transaction and an uncommitted run insert, verify invisibility
to another connection, then reopen/recover and commit successfully.

These tests establish local macOS process-crash recovery and logical metadata
atomicity. They do **not** establish physical power-loss durability: no physical
storage fault injection, directory fsync verification, hardware flush proof, or
macOS fullfsync evidence was collected. Output files, content-addressed logs,
and environment lockfiles remain outside the metadata transaction. Independent
UI requests may span a commit and do not share a multi-request snapshot.

Source validation and local record lookup scan the full history and original
source bytes; very large ledgers need a future measured optimization. There is
no downgrade/export utility, live JSONL projection, or user-facing activation
control. Do not remove an activated DB to downgrade, as new metadata exists
only there. Windows/Linux execution and native desktop UI validation remain
unperformed. The preexisting schema still stores run records as JSON; this
implementation does not redesign remote lineage or run-ID generation.

## Validation

Executed on macOS/Darwin, without desktop launch, providers, installed-app
changes, pushes, or PRs:

- `cargo test -p osd-core --offline`: initial worker run 277 passed; coordinator follow-up run **280 passed, 0 failed, 1 ignored**;
  doc tests 0. The existing ignored test is
  `system_proxy::tests::live_system_proxy_matches_expectation`.
- New ledger tests cover preserved preexisting JSONL import, imported run links,
  explicit compatibility boundary, authored-call deduplication, retry snapshot
  reuse, built-in run-index visibility, source modification rejection, rollback
  of a run plus its first link when the second link fails, repeated commits,
  standalone-link rejection, corrupt sources, unknown partial migration, missing
  legacy links, interrupted migration recovery, and a real child-process exit
  before commit while a separate reader sees no uncommitted run.
- Coordinator follow-up added a migrated three-process same-run/authored-writer
  regression, rollback after an injected SQLite failure on the second output
  link through `record_run_inner`, and index transition from a preexisting
  `runs.db` with later local and remote runs. It also closes the index connection
  before fixture cleanup on Windows. All three new tests passed on macOS;
  native Windows/Linux validation remains pending.
- `cargo check -p osd-cli --offline`: exit 0. Build warning: desktop web `dist`
  is absent, so no web client is embedded; a deployable web bundle is untested.
- `cargo run -p osd-cli --offline -- --help`: exit 0; help returns without
  creating a server or accessing runtime/provider credentials.
- `git diff --check`: passed.

Full command outputs are retained locally as ignored worktree artifacts:
`transaction-core-tests.log`, `transaction-cli-check.log`, and
`transaction-cli-help.log`.

## Exact changed files

1. `crates/osd-core/src/ledger.rs` — new transactional storage, strict import,
   recovery/activation API, and focused tests.
2. `crates/osd-core/src/lib.rs` — exports the ledger module.
3. `crates/osd-core/src/provenance.rs` — switches readers/authored appends after
   activation, guards standalone links, and checks version overflow.
4. `crates/osd-core/src/runs.rs` — routes reads/retries/commits through SQLite.
5. `crates/osd-core/src/runs_index.rs` — ingests committed SQLite local records.
6. `runtime/skills/core/traceability-review/SKILL.md` — frozen-history guard.
7. `docs/TECHNICAL_DESIGN.md` — migration, compatibility, recovery, and durability
   contract and documented remaining limits.
8. `PROGRESS.md` — implementation milestone and bounded validation result.
9. `TRANSACTION_REPORT.md` — this durable handoff report.
