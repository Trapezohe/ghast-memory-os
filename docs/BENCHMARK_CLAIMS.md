# gmOS Benchmark Claims Methodology

gmOS benchmark numbers are reproducibility claims first and comparison claims
only when the protocol matches.

## What gmOS Numbers Mean

`deterministic_local` runs are local adapter diagnostics. They measure how gmOS
maps a dataset into memory events, retrieves or reconstructs context, and checks
answers with deterministic string and evidence rules. They do not call a model
judge and are not leaderboard scores.

`official_protocol` runs are host-judged runs through the SDK benchmark runner.
They require a disclosed judge callback, judge name, dataset revision, settings,
and reproduction bundle. The gmOS CLI refuses to run `official_protocol` because
it cannot provide a host judge.

Intelligence-enabled runs disclose the configured model names, embedding model
names, endpoint hostname, concurrency, timeout, ingest mode, and maintenance
phases. API key values are never recorded; only environment variable names may
appear in manifests.

## What Is Not Comparable

Do not compare `deterministic_local` scores to leaderboard or paper claims. A
model-judged official-protocol result, such as a Hindsight LongMemEval claim,
uses a judge model and extraction stack that are outside gmOS deterministic
adapter scoring.

Do not describe deterministic adapter results as official LongMemEval, LoCoMo,
STATE-Bench, Mem2ActBench, BEAM, SOTA, or leaderboard scores.

## Apples-To-Apples Requirements

A fair comparison requires:

- the same dataset revision and dataset hash;
- the same split, filtering, and case count;
- the same official runner or a strictly equivalent protocol;
- the same judge model, settings, prompt, scoring rubric, and retry policy;
- disclosed extraction, ingestion, retrieval, and reconstruction stack;
- disclosed intelligence model names when model-backed hooks are enabled;
- per-case outputs, failure samples, run manifest, and exact rerun command.

## Publication Commitment

Every public gmOS number must link to a reproduction bundle containing
`manifest.json`, `results.json`, `results.md`, `failure-samples.json`, and
`REPRODUCE.md`.

If a bundle is missing dataset hash, git SHA, dirty status, options, judge
provenance, or intelligence provenance, the result may be used for local
diagnostics only and must not be used as a public comparison claim.
