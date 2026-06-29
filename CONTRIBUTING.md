# Contributing

gmOS is a local-first Agent memory runtime. Contributions should improve the
general memory system, not a single benchmark score.

## Local Setup

```bash
npm ci
npm run gate:pr
```

`gate:pr` is the required PR gate. It runs build/test, published examples,
the core no-benchmark-special-casing scan, consumer install smoke,
deterministic Memory Gym smoke, external fixtures, the SDK release gate, scale
smoke, and a pack dry run.

## Runtime Changes

- Keep changes modular and small.
- Prefer existing helpers and public SDK boundaries.
- Do not add dependencies unless the standard library and current dependencies
  are not enough.
- Do not copy gmOS internals into host applications.
- Do not add UI, cloud storage, encryption, or dashboard assumptions to the SDK
  unless that behavior is explicitly scoped.

## Benchmark Rules

- Core runtime code must not branch on dataset names, benchmark names, case IDs,
  fixture text, hidden worlds, or scenario names.
- Core runtime code must not hard-code external fixture answers or forbidden
  answers.
- Deterministic external QA adapters may only map schema, normalize answers,
  and score results. Official protocol bridges, such as STATE-Bench, must keep
  their protocol-specific work outside core runtime behavior.
- Score changes must be explainable as general memory capability changes:
  extraction, entity, time, evidence, retrieval, reconstruction, context,
  safety, or action policy.
- Deterministic adapter results are not official benchmark scores and must not
  be presented as SOTA claims.

## PR Checklist

- `npm run gate:pr` passes.
- Any behavior change has the smallest useful regression test.
- Public docs are updated when an API, CLI, gate, or safety boundary changes.
- Security/privacy behavior is not weakened: secret-like, incognito, sensitive,
  PERSON, forget, and do-not-push gates must keep passing.
