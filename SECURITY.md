# Security And Privacy

gmOS is local-first and uses plaintext SQLite by default. It does not provide
database encryption, vault integration, hosted sync, or cloud custody.

## Supported Scope

Security fixes target the current `main` branch and the latest published alpha.
Older alpha versions should be upgraded before reporting a reproduction as
current behavior.

## Trust Model

- Host applications own filesystem permissions and database placement.
- gmOS memory policy rejects secret-like long-term memory by default.
- Incognito/private events are not promoted to long-term memory.
- Ordinary context excludes sensitive memory unless a trusted host caller
  explicitly requests it.
- Public MCP/HTTP surfaces do not expose sensitive override switches.
- Forget operations archive matching memory and remove it from future context.
- Read paths are expected to be side-effect free and are covered by gate checks.

## Reporting

Do not include real user memory, API keys, private transcripts, or production
SQLite files in a public issue.

Use GitHub private vulnerability reporting when available. If private reporting
is not available, open a public issue with a minimal synthetic reproduction and
omit sensitive data.

Useful reports include:

- gmOS version and commit SHA;
- Node.js version and OS;
- exact command or SDK call;
- expected result and actual result;
- a synthetic database or fixture when needed.

## Non-Security Issues

Benchmark score changes, missing product features, and expected plaintext local
storage behavior are not security vulnerabilities. File those as normal issues
or PRs.
