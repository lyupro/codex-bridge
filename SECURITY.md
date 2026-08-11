# Security Policy

## Supported versions

Security fixes are provided for the latest minor release line only.

| Version | Supported |
| --- | --- |
| 0.5.x | Yes |
| 0.4.x | No |
| < 0.4 | No |

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/lyupro/codex-bridge/security/advisories/new). Do not open a public issue for an undisclosed vulnerability.

Please include the affected package version, operating system, Codex CLI version, reproduction steps, impact, and any suggested mitigation. Remove secrets and unrelated operator data from logs or run artifacts before attaching them.

We aim to:

- acknowledge a report within 3 business days;
- provide an initial assessment within 7 business days;
- send a status update at least every 14 days until resolution; and
- coordinate disclosure after a fix is available, or explain why no fix is planned.

These are response targets, not a guarantee of remediation within a fixed period. Timing depends on severity, reproducibility, and release risk.

## Files and settings the package manages

The installer has two roots and may also install one shared Codex rule file:

- `~/.lyupro/.codex-bridge/` receives package runtime files, guards, package metadata, the installation record, and operator-owned seeded configuration and conventions.
- The selected Claude Code root, either `~/.claude/` or `<repo>/.claude/`, receives package agent and slash-command files. Its `settings.json` receives this package's hook registrations and, only when requested through `permissions add`, the package's exact allow and deny rule strings.
- The active Codex home receives the package's managed rule file under `rules/`.

### Backups and update safety

Before changing an existing `settings.json`, codex-bridge writes a timestamped backup beside it. Updates preserve operator-owned seeded configuration, refuse changed package files unless `--force` is explicit, and remove obsolete files only when their recorded fingerprint is unchanged.

### Files never removed by codex-bridge

Uninstall removes only recorded package files, hook registrations, and exact permission strings owned by codex-bridge. It never removes `codex-runs/`, operator-authored foreign settings or hooks, changed files it does not own, shared Claude Code directories, or operator-owned configuration and conventions.
