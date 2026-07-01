# gmOS Benchmark Runs

This page archives local deterministic benchmark snapshots. These are not
official benchmark scores, leaderboard claims, or SOTA claims.

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
