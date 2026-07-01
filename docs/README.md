# gmOS Documentation

gmOS is an open-source, local-first Memory OS for personal agents. The long-term
vision is to help agents become a user's second brain and digital twin
infrastructure by learning experience over time, maintaining a user-world model,
reconstructing context from evidence, and keeping memory explainable,
forgettable, and testable.

The current npm package is the late-alpha runtime kernel for that vision, not a
finished digital twin product. This directory contains the stable integration
docs shipped with the package. The root README is the project overview; these
files are the working references for host applications.

These docs define the public integration surface, safety boundaries, and
benchmark claim rules for the alpha runtime. Benchmark scores should be used to
diagnose general memory capability gaps, not to justify dataset-specific
runtime branches.

- [API reference](./API_REFERENCE.md): public SDK, CLI, MCP, HTTP, and store
  surfaces.
- [MCP and HTTP integration guide](./INTEGRATION_GUIDE.md): host boundary
  choices, public tool contracts, and local service smoke tests.
- [Structured extraction contract](./STRUCTURED_EXTRACTION.md): host-owned memory
  candidates, entity/time cues, and validation responsibilities.
- [Architecture guide](./ARCHITECTURE.md): source-of-truth boundaries and data
  flow.
- [Benchmark guide](./BENCHMARKING.md): SDK gates, external adapters, and
  claim boundaries.
- [Benchmark runs](./BENCHMARK_RUNS.md): archived local deterministic baseline
  snapshots.
- [Migration guide](./MIGRATION.md): host snapshot import, profile backup, and
  safe rollout steps.

Runnable examples are shipped under `examples/`: `quickstart.mjs`,
`structured-extractor.mjs`, `agent-adapter.mjs`, `host-adapter.mjs`,
`http-adapter.mjs`, `mcp-router.mjs`, and `external-mini-benchmark.mjs`.
