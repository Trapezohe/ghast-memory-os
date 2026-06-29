# gmOS API Reference

gmOS is a local-first TypeScript memory runtime. Public callers should use the
package exports listed here and avoid importing files under `dist/` or `src/`.

## Package Exports

- `@ghast/memory`: runtime facade, core types, structured extractor factory,
  and `getGmosRuntimeInfo()`.
- `@ghast/memory/store/sqlite`: plaintext SQLite store and profile
  backup/restore helpers.
- `@ghast/memory/mcp`: in-process MCP-style router and stdio server helpers.
- `@ghast/memory/http`: local HTTP adapter.
- `@ghast/memory/host`: host compatibility and snapshot import/export helpers.
- `@ghast/memory/diagnostics`: read-only status reports.
- `@ghast/memory/gym`: deterministic gates and benchmark adapters.
- `@ghast/memory/evolution`: report-only failure review control plane.

## Runtime Facade

Create the runtime with an explicit store:

```ts
import { createMemoryOS } from "@ghast/memory";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const store = createSqliteMemoryStore({ path: "./gmos.db" });
const memory = createMemoryOS({ profileId: "local-user", store });
```

Primary methods:

- `observe(event)`: record a host event, extract eligible long-term memory, and
  attach evidence.
- `prepareTurn(input)`: retrieve ordinary context and action policy for the next
  agent turn. This is a read path and must not write.
- `reconstructContext(input)`: run bounded cue/tag/content reconstruction with
  evidence convergence and planner trace metadata.
- `explainEvidencePath(input)`: explain why evidence was selected for a query.
- `commitOutcome(input)`: record task outcome signals.
- `recordFeedback(input)`: record user or host feedback into the failure loop.
- `forget(input)`: archive matching memory and remove it from future context.
- `explain(input)`: explain a memory or belief without exposing unsafe content.

Low-level compatibility methods such as `add`, `search`, `history`, `list`,
`get`, `update`, `delete`, `backup`, and `restore` exist for migration,
administration, and host adapters that cannot emit full events yet. Prefer
`observe()` and `prepareTurn()` for agent runtime integration.

## CLI

The npm package exposes two binaries:

- `gmos`
- `ghast-memory`

Useful integration commands:

```bash
gmos version --format json
gmos init --db ./gmos.db
gmos doctor --db ./gmos.db --host ghast --format markdown
gmos status --db ./gmos.db --profile local --host ghast --format markdown
gmos observe --db ./gmos.db --profile local --text "I prefer short answers."
gmos prepare --db ./gmos.db --profile local --text "How should you answer me?"
gmos reconstruct --db ./gmos.db --profile local --text "What is the project next step?"
gmos forget --db ./gmos.db --profile local --query "old project"
gmos gate --generated-seeds 3 --scale-sizes 100,1000 --format markdown
```

`doctor`, `status`, `gate`, and report-style gym commands support JSON output
by default and markdown output with `--format markdown`. Use `--json-file` and
`--markdown-file` on commands that expose those artifact flags when building
reproducibility bundles.

## MCP Surface

The MCP-style surface exposes public tools for hosts that integrate by tool
calls instead of direct SDK imports:

- `memory.add`
- `memory.search`
- `memory.observe`
- `memory.prepare_context`
- `memory.reconstruct_context`
- `memory.explain_evidence_path`
- `memory.commit_outcome`
- `memory.record_feedback`
- `memory.forget`
- `memory.explain_belief`
- `memory.runtime_info`

Public MCP tools intentionally do not expose sensitive override switches.

## HTTP Surface

The local HTTP adapter exposes:

- `GET /health`
- `GET /runtime-info`
- `GET /tools`
- `GET /status`
- `POST /add`
- `POST /search`
- `POST /observe`
- `POST /prepare`
- `POST /reconstruct`
- `POST /explain-path`
- `POST /commit-outcome`
- `POST /feedback`
- `POST /forget`
- `POST /explain`
- `POST /mcp/call`

Use an auth token for local service boundaries that are reachable by more than
one process.

Run `examples/http-adapter.mjs` for a minimal host-style smoke test. The example
starts an ephemeral localhost server with bearer auth, rejects unauthenticated
non-health requests, records a preference through `/observe`, prepares context
through `/prepare`, reads `/status`, and deletes its temporary plaintext SQLite
database.

## Diagnostics Contract

`getGmosRuntimeInfo()`, `gmos version`, `gmos doctor`, `/runtime-info`,
`memory.runtime_info`, and `createMemoryStatusReport()` expose content-free
runtime and integration metadata. They report package, CLI, export, MCP, HTTP,
and local-first trust contract information. They do not include memory text,
failure samples, or table state hashes.
