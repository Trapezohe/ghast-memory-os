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

The root README also defines the external learning posture: gmOS should study
strong open-source memory systems and adopt their general mechanisms only when
they strengthen local-first, evidence-backed, forgettable memory behavior. It
must not add benchmark-specific runtime branches.

- [API reference](./API_REFERENCE.md): public SDK, CLI, MCP, HTTP, and store
  surfaces.
- [MCP and HTTP integration guide](./INTEGRATION_GUIDE.md): host boundary
  choices, public tool contracts, and local service smoke tests.
- [Architecture guide](./ARCHITECTURE.md): source-of-truth boundaries and data
  flow.
- [Benchmark guide](./BENCHMARKING.md): internal gates, external adapters, and
  claim boundaries.
- [Migration guide](./MIGRATION.md): host snapshot import, profile backup, and
  safe rollout steps.

Runnable examples are shipped under `examples/`: `quickstart.mjs`,
`agent-adapter.mjs`, `host-adapter.mjs`, `http-adapter.mjs`,
`mcp-router.mjs`, and `external-mini-benchmark.mjs`.
