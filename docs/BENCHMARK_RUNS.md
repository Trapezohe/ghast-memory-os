# gmOS Benchmark Runs

This page archives local deterministic benchmark snapshots. These are not
official benchmark scores, leaderboard claims, or SOTA claims.

## alpha.69 release evidence snapshot

Run date: 2026-07-02.

Manifest completeness: full local release evidence bundle.

- Package: `@ghast/memory@0.1.0-alpha.69`.
- Git SHA: `3756ae347c90f733efb79d5b44a6978233c11eb8`.
- Dirty worktree: `no`.
- Command:
  `npm run release:evidence -- --output-dir ./release-evidence/alpha69-3756ae3`.
- PR gate command: `npm run gate:pr`.
- Release evidence checks: `28/28` pass.
- CI policy in the bundle: push trigger absent; remote CI is opt-in through
  `workflow_dispatch`.

The release evidence bundle verified the local PR gate, npm pack tarball generation, fresh
tarball install, SDK smoke, agent adapter smoke, host adapter smoke, local HTTP
smoke, MCP smoke, CLI smoke, backup/restore smoke, report-only evolution smoke,
doctor/status/inspector content-safety checks, and cleanup of generated
plaintext SQLite and npm cache artifacts.
The inspector check also verifies that `consumer.db`, `consumer.db-wal`, and
`consumer.db-shm` are unchanged after inspection.

This entry is a local SDK release gate snapshot. It is not an official
LongMemEval, LoCoMo, STATE-Bench, Mem2ActBench, or BEAM score. Use it to
reproduce package health and integration safety for this commit, not to claim
external benchmark ranking.

## alpha.67 local adapter snapshot

Run date: 2026-06-29.

Manifest completeness: partial legacy snapshot.

- Git SHA: not recorded in the tracked docs.
- Dataset hashes: not recorded in the tracked docs.
- Commands/options: not recorded beyond local deterministic adapter format.
- Failure samples: not recorded in the tracked docs.

Use this entry only for historical continuity. New public benchmark entries
should include the full manifest fields listed in
[benchmarking](./BENCHMARKING.md).

| Dataset file | Source format | Scored cases | Deterministic adapter score | Runtime |
| --- | --- | ---: | ---: | ---: |
| `longmemeval_oracle.json` | LongMemEval cleaned oracle | 470 | `0.2404` | 26.3s |
| `longmemeval_s_cleaned.json` | LongMemEval cleaned S | 470 | `0.2532` | 1284.2s |
| `locomo10.json` | LoCoMo full history | 1542 | `0.1089` | 363.4s |

Dataset sources:
[LongMemEval cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned),
[LongMemEval GitHub](https://github.com/xiaowu0162/longmemeval), and
[LoCoMo GitHub](https://github.com/snap-research/locomo).

Interpretation: use these numbers to diagnose extraction, speaker/person/entity
grounding, temporal current/history state, reconstruction, and context
composition gaps. Do not compare them to official protocol scores.
