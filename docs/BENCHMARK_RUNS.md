# gmOS Benchmark Runs

This page archives benchmark snapshots. Unless an entry explicitly says
`protocol=official_protocol`, `officialProtocol=host_reader_and_judge`, and
names both the host-provided answerer and judge, it is not an official
leaderboard-comparable claim.

## Publishing a run

Public benchmark entries require a reproduction bundle generated with
`gmos gym external --reproduction-bundle <dir>` (or the optional
`gmos gym external gains --reproduction-bundle <dir>` label) or the equivalent
`@ghast/memory/gym` SDK helper after an official-protocol SDK run.

Required manifest fields:

- git branch, SHA, and dirty status;
- package name and version;
- Node.js version and platform;
- dataset id, format, case count, hash, and warnings;
- full run options, including protocol, convergence, temporal mode,
  sensitivity, diagnostics, concurrency, and failure sample limit;
- judge provenance for `official_protocol` runs;
- score semantics and official-comparability flag;
- lexical ceiling, reachable score, and unreachable count for deterministic
  runs;
- answerer provenance for reader-mode official runs;
- intelligence provenance when enabled: model names, endpoint hostname, ingest
  mode, maintenance phases, concurrency, timeout, hook names, and API key
  environment variable name only.

Bundles live in a `release-evidence/` style local directory that stays
git-ignored. Maintainers publish the bundle as a release asset for public
numbers; this repository does not vendor datasets or generated run archives.

Claim language rules:

- `deterministic_local` means local adapter diagnostics only.
- `officialProtocol=host_judge_context` means a host judge scored sanitized
  context; it is not leaderboard-comparable.
- `officialProtocol=host_reader_and_judge` means a host reader generated an
  answer from sanitized context and a host judge scored that answer.
- Intelligence-enabled runs disclose model names and endpoint hostnames, never
  secret values.
- No run may be called official, leaderboard, or SOTA unless the manifest says
  `protocol=official_protocol`, `officialProtocol=host_reader_and_judge`, names
  both answerer and judge, and the public bundle is available.

Future run table columns should include raw score, lexical ceiling, reachable
score, unreachable count, protocol, officialProtocol, judge, and answerer.

## alpha.69 release evidence snapshot

Run date: 2026-07-02.

Manifest completeness: full local release evidence bundle.

- Package: `@ghast/memory@0.1.0-alpha.69`.
- Git SHA: `9011902321b93e7c108d152b3e69c952f8e97ac2`.
- Dirty worktree: `no`.
- Shell command:
  `npm run release:evidence -- --output-dir ./release-evidence/alpha69-9011902`.
- Manifest invocation:
  `node scripts/create-release-evidence.mjs --output-dir ./release-evidence/alpha69-9011902`.
- PR gate command: `npm run gate:pr`.
- Release evidence checks: `30/30` pass.
- Tarball filename, size, sha512, and npm-style SRI integrity were recorded
  in the local release evidence manifest.
- CI policy in the bundle: push trigger absent; remote CI is opt-in through
  `workflow_dispatch`.

The release evidence bundle verified the local PR gate, npm pack tarball generation, fresh
tarball install, SDK smoke, agent adapter smoke, host adapter smoke, local HTTP
smoke, MCP smoke, installed public CLI smoke for `gmos`, `ghast-memory`, and
`gmos-inspect`, backup/restore smoke, approval-gated evolution smoke,
doctor/status/inspector content-safety checks, and cleanup of generated
plaintext SQLite and npm cache artifacts.
The inspector check also verifies numeric health, evidence, failure, forget,
and reconstruction counters, and confirms that `consumer.db`, `consumer.db-wal`,
and `consumer.db-shm` are unchanged after inspection.

This entry is a local SDK release gate snapshot. It is not an official
LongMemEval, LoCoMo, STATE-Bench, Mem2ActBench, or BEAM score. Use it to
reproduce package health and integration safety for this commit, not to claim
external benchmark ranking.

Protocol: `deterministic_local`. Official protocol: `not_run`.

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

| Dataset file | Source format | Protocol | Scored cases | Deterministic adapter score | Runtime |
| --- | --- | --- | ---: | ---: | ---: |
| `longmemeval_oracle.json` | LongMemEval cleaned oracle | `deterministic_local` | 470 | `0.2404` | 26.3s |
| `longmemeval_s_cleaned.json` | LongMemEval cleaned S | `deterministic_local` | 470 | `0.2532` | 1284.2s |
| `locomo10.json` | LoCoMo full history | `deterministic_local` | 1542 | `0.1089` | 363.4s |

Dataset sources:
[LongMemEval cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned),
[LongMemEval GitHub](https://github.com/xiaowu0162/longmemeval), and
[LoCoMo GitHub](https://github.com/snap-research/locomo).

Interpretation: use these numbers to diagnose extraction, speaker/person/entity
grounding, temporal current/history state, reconstruction, and context
composition gaps. Do not compare them to official protocol scores.
