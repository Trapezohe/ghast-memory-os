# Release Checklist

This checklist is for gmOS alpha, release-candidate, and public benchmark
releases. It keeps release claims tied to reproducible evidence.

## Preflight

- Worktree is clean before running release evidence.
- Version in `package.json` matches the artifact being tested.
- No runtime benchmark special-casing was added.
- Any benchmark score change has a capability explanation: extraction, entity,
  time, evidence, retrieval, reconstruction, context, safety, or action policy.
- Security boundaries are unchanged or explicitly reviewed: secret-like,
  incognito, sensitive, PERSON, forget, and do-not-push.

## PR Gate

Run before every merge:

```bash
npm run gate:pr
```

This covers build/test, examples, no-benchmark-special-casing scan, consumer
install smoke, Memory Gym smoke, external fixtures, release gate, scale smoke,
and pack dry run.

## Alpha Gate

Run before publishing a new alpha:

```bash
npm run gate:pr
npm run release:evidence -- --output-dir ./release-evidence/<version>-<short-sha>
node dist/cli/gmos.js gym external-suite --suite-file <release-suite.json> --output-dir ./external-runs --format json --markdown-file ./external-suite.md
```

Archive the release evidence directory plus the suite JSON, markdown report,
and manifest. The release evidence bundle contains `manifest.json`,
`SUMMARY.md`, command logs, the packed tarball, and a fresh-install smoke
workspace. The report must include:

- gmOS package version;
- git branch, SHA, and dirty status;
- dataset file hashes;
- suite parameters, seed list, concurrency, and failure sample limit;
- model, judge, temperature, and max-token settings, or `N/A` for deterministic
  local adapter runs;
- run start time, finish time, and runtime;
- scored case counts;
- failure-stage taxonomy;
- failed case samples.

Alpha benchmark output is a deterministic adapter baseline. Do not call it an
official LongMemEval, LoCoMo, STATE-Bench, or SOTA score.

`npm run release:evidence` requires a clean worktree by default. It runs
`gate:pr`, creates a tarball, installs that tarball into a fresh consumer
project, verifies SDK imports, plaintext SQLite behavior, context preparation,
evidence return, and the installed `gmos` CLI. `--skip-gate`,
`--skip-fresh-install`, and `--allow-dirty` are for local diagnostics only and
must not be used for public release evidence.

## Release Candidate Gate

Run all alpha checks plus:

- larger external deterministic suite;
- official protocol dry-run or official runner result;
- host/MCP/HTTP integration smoke in the consuming app;
- migration or snapshot import rehearsal when schema or host boundaries changed;
- API, migration, documentation, and security review;
- independent review score of at least `95/100`.

## Release Readiness Scorecard

Score every alpha, release candidate, and public release on this 100 point
checklist:

- API and package structure stability: 15
- SQLite, migration, and read-audit: 10
- CLI, MCP, HTTP, and host boundary: 10
- Safety gates for forget, PERSON, incognito, secret-like, sensitive, and
  do-not-push: 15
- Extraction, entity, time, and evidence capability: 15
- Reconstructive retrieval and context composer: 10
- Benchmark reproducibility and reporting: 10
- No benchmark special-casing audit: 10
- Documentation and developer experience: 5

Block the alpha, release candidate, or public release if any of these fail:

- no-benchmark-special-casing audit is not full pass;
- safety gates score below `14/15`;
- safety gate regression;
- read-path side effect check failure;
- missing no-benchmark-special-casing audit;
- public report without git SHA, dirty status, dataset hash, or run parameters;
- benchmark improvement that cannot be explained by a general memory capability.

## Known Limitations for Public Notes

Keep these limitations visible in public alpha, beta, and release-candidate
notes until the underlying capability is proven by current evidence:

- gmOS is plaintext local SQLite by design. It does not provide database
  encryption, cloud custody, or hosted synchronization.
- Built-in extraction remains a conservative rule fallback; broad production
  extraction requires a host-provided structured extractor profile.
- Deterministic LongMemEval and LoCoMo adapter scores are weak diagnostic
  baselines, not official LLM-judge or leaderboard results.
- STATE-Bench, Mem2ActBench, BEAM, and similar claims require their unchanged
  official runners, fixed model/judge settings, and public reproduction bundle.
- ghast_desktop production replacement requires SDK release evidence plus
  app-side Electron E2E migration evidence.

## Official Benchmark Claims

Only make official or SOTA-style claims when the run uses the official dataset,
official runner or strictly equivalent protocol, fixed model and judge settings,
and a public reproduction bundle.

For STATE-Bench, gmOS may prepare learnings and write the agent hook, but the
comparable number must come from the unchanged STATE-Bench protocol.

## Publish

```bash
npm pack --dry-run
npm publish --access public
```

After publish:

- install the published package in a fresh temporary project;
- run quickstart and consumer smoke against the published package;
- tag the release commit;
- update the README baseline only if the new report is reproducible;
- keep weak external benchmark baselines visible instead of replacing them with
  only aggregate scores.
