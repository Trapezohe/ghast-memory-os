# gmOS Benchmark Claims Methodology

gmOS benchmark numbers are reproducibility claims first and comparison claims
only when the protocol matches.

## What gmOS Numbers Mean

`deterministic_local` runs are local adapter diagnostics. They measure how gmOS
maps a dataset into memory events, retrieves or reconstructs context, and checks
answers with deterministic string and evidence rules. They do not call a model
judge and are not leaderboard scores.

Deterministic reports also publish `lexicalCeiling`, `reachableScore`, and
`unreachableCount`. These are honesty metrics derived from cases whose gold
answer text is not present in the input; they do not change scoring.

`official_protocol` runs have two manifest modes:

- `host_judge_context`: a host-provided judge scores the sanitized gmOS context.
  This verifies judge wiring but is not leaderboard-comparable because no reader
  generated an answer.
- `host_reader_and_judge`: a host-provided answerer receives only the question
  and sanitized context, generates an answer, and a host-provided judge scores
  that generated answer. This is the only gmOS mode that can be compared to
  reader+judge benchmark claims when the rest of the protocol also matches.

Intelligence-enabled runs disclose the configured model names, embedding model
names, endpoint hostname, concurrency, timeout, ingest mode, and maintenance
phases. API key values are never recorded; only environment variable names may
appear in manifests.

## What Is Not Comparable

Do not compare `deterministic_local` or `host_judge_context` scores to
leaderboard or paper claims. A model-judged reader+judge result, such as a
Hindsight LongMemEval claim, uses a reader, judge model, and extraction stack
that are outside gmOS deterministic adapter scoring.

Do not describe deterministic adapter results as official LongMemEval, LoCoMo,
STATE-Bench, Mem2ActBench, BEAM, SOTA, or leaderboard scores.

## Apples-To-Apples Requirements

A fair comparison requires:

- the same dataset revision and dataset hash;
- the same split, filtering, and case count;
- the same official runner or a strictly equivalent protocol;
- the same judge model, settings, prompt, scoring rubric, and retry policy;
- the same reader model, settings, prompt, context sanitization, and retry
  policy when the target claim uses a reader;
- disclosed extraction, ingestion, retrieval, and reconstruction stack;
- disclosed intelligence model names when model-backed hooks are enabled;
- per-case outputs, failure samples, run manifest, and exact rerun command.

## Publication Commitment

Every public gmOS number must link to a reproduction bundle containing
`manifest.json`, `results.json`, `results.md`, `failure-samples.json`, and
`REPRODUCE.md`.

If a bundle is missing dataset hash, git SHA, dirty status, options, judge
provenance, answerer provenance for reader mode, ceiling metrics for
deterministic mode, or intelligence provenance, the result may be used for local
diagnostics only and must not be used as a public comparison claim.
