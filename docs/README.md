# gmOS Documentation

This directory contains the stable integration docs shipped with the npm
package. The root README is the project overview; these files are the working
references for host applications.

- [API reference](./API_REFERENCE.md): public SDK, CLI, MCP, HTTP, and store
  surfaces.
- [Architecture guide](./ARCHITECTURE.md): source-of-truth boundaries and data
  flow.
- [Benchmark guide](./BENCHMARKING.md): internal gates, external adapters, and
  claim boundaries.
- [Migration guide](./MIGRATION.md): host snapshot import, profile backup, and
  safe rollout steps.

Runnable examples are shipped under `examples/`: `quickstart.mjs`,
`host-adapter.mjs`, and `http-adapter.mjs`.
