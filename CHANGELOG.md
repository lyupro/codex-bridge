# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - unreleased

### Added

- Three dispatcher agents for reconnaissance (`codex-scout`), scoped implementation (`codex-build`), and independent review (`codex-review`), each with a structured response contract.
- A delegating runner that separates the launcher from a detached worker, preserves run artifacts after a dropped call, and supports configurable artifact roots.
- A zero-dependency `codex-bridge` CLI with `install`, `uninstall`, `update`, and `doctor`, including user/project scopes, dry runs, force handling, idempotent installs, hook merging with backups, and manifest-based ownership tracking.
- A reply guard hook that blocks dispatcher replies that do not match the recorded run state or required response shape.
- Run-chain and busy-tree lock protections: repeated work is linked across runs, an unfinished chain requires explicit `--continue`, and concurrent writing runs for one repository are refused before Codex starts.
- Scope and coverage validation: implementation changes must stay within the declared scope, report/worktree mismatches fail the run, and reconnaissance reports must account for all requested subquestions.
- Package-managed Codex execution rules that forbid history-, branch-, index-, and worktree-destructive operations, writes inside `.git`, and other unsafe repository mutations while leaving the operator's existing rules untouched.
- A 400-line source-file size gate with explicit rationale required for exclusions.

### Changed

- Run identity now includes an orchestrator-issued mandatory `--order-id`, stored with run state and used alongside the task identity to detect repeats even when a run is renamed.
- Runs now snapshot both branch and `HEAD` before and after execution; branch changes, detached `HEAD`, and commit drift are treated as failures, with preflight refusal for a subsequent run when an abandoned run left repository state out of sync.
- English-language prompts and runner/command output are shipped for the three dispatchers and their supporting commands.
- Installation updates track installed file contents so outdated package files can be refreshed without overwriting hand edits unless `--force` is requested.

### Fixed

- Prevented environment and service writes from being misreported as delegated work while keeping them visible in run results.
- Prevented different repositories with the same directory name from sharing run history.
- Prevented malformed state files, including files with a byte-order mark, from silently bypassing abandoned-run detection, busy-tree locking, and chain lookup.
- Fixed diagnostics to report the run folder actually used by the runner and to continue reporting remaining checks when a project marker is unreadable.
