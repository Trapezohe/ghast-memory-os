# Ghast Memory OS

Ghast Memory OS, or gmOS, is a local-first actionable user-world memory runtime
for personal agents.

This repository is the SDK/runtime extraction target for Ghast's memory system.
It is not a vector-memory CRUD wrapper. The public path is:

```ts
import { createMemoryOS } from "@ghast/memory";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const memory = createMemoryOS({
  profileId: "local-user",
  store: createSqliteMemoryStore({ path: "./gmos.db" }),
});

await memory.observe({
  type: "conversation.message",
  profileId: "local-user",
  role: "user",
  content: "以后不要再提醒我这个项目延期了。",
  createdAt: new Date().toISOString(),
});

const prepared = await memory.prepareTurn({
  profileId: "local-user",
  messages: [{ role: "user", content: "这个项目现在怎么办？" }],
});
```

## Current Scope

- Plaintext local SQLite store. No database encryption and no vault integration.
- Runtime facade: `observe`, `prepareTurn`, `commitOutcome`, `recordFeedback`,
  `forget`, `explain`.
- Low-level compatibility APIs: `add` and `search` for import, admin, and
  compatibility use cases that cannot emit full host events.
- Safety gates for secret-like content, incognito events, PERSON isolation,
  forgetting, and do-not-push action policies.
- Built-in deterministic Memory Gym smoke benchmark.
- Built-in release gate runner that combines Memory Gym, host compatibility,
  scale, and diagnostics checks for CI/release candidates.
- Host compatibility reports for Ghast, MCP, search-only, and mock L3 adapters.
- Host memory snapshot import for adapters that need to project an existing
  memory store into gmOS.
- Host memory snapshot sync for adapters that need stale imported memories
  archived when the host source changes.
- In-process MCP-style tool router and real MCP stdio server for host/agent
  runtime adapters.
- Local HTTP adapter for hosts that need a small service boundary instead of
  in-process imports or MCP stdio.
- Read-only diagnostics/status report for schema, row counts, failure summary,
  package version, and host compatibility.
- Report-only evolution failure review for clustering failure logs into
  hypotheses and patch candidates without auto-apply or auto-rollout.
- CLI: `gmos`.

## CLI

```bash
npm install
npm run build

node dist/cli/gmos.js init --db ./gmos.db
node dist/cli/gmos.js doctor --db ./gmos.db --host ghast
node dist/cli/gmos.js status --db ./gmos.db --profile local --host ghast --format markdown
node dist/cli/gmos.js add --db ./gmos.db --profile local --kind preference --text "我喜欢简洁回答"
node dist/cli/gmos.js update --db ./gmos.db --profile local --id memory_xxx --text "我喜欢先讲风险"
node dist/cli/gmos.js delete --db ./gmos.db --profile local --id memory_xxx
node dist/cli/gmos.js clear --db ./gmos.db --profile local --scope global
node dist/cli/gmos.js search --db ./gmos.db --profile local --query "简洁"
node dist/cli/gmos.js observe --db ./gmos.db --profile local --text "我喜欢简洁的中文回答。"
node dist/cli/gmos.js prepare --db ./gmos.db --profile local --text "你之后怎么回答我？"
node dist/cli/gmos.js mcp tools
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.prepare_context --input '{"text":"你之后怎么回答我？"}'
node dist/cli/gmos.js mcp serve --db ./gmos.db --profile local
node dist/cli/gmos.js http serve --db ./gmos.db --profile local --port 4787 --host ghast
node dist/cli/gmos.js evolution report --db ./gmos.db --profile local --format markdown
node dist/cli/gmos.js gate --generated-seeds 3 --scale-sizes 100,1000 --format markdown
node dist/cli/gmos.js gym run --db :memory: --generated-seeds 3
node dist/cli/gmos.js gym run --generated-seeds 10 --format markdown --report-file ./memory-gym.md
node dist/cli/gmos.js gym scale --sizes 100,1000
node dist/cli/gmos.js gym gate --generated-seeds 3 --scale-sizes 100,1000 --format json
node dist/cli/gmos.js gym host --hosts ghast,mcp,mock_l3,search_only --format markdown
```

## QA Gates

```bash
npm run check
npm run test:consumer
node dist/cli/gmos.js gate --generated-seeds 3 --scale-sizes 100,1000 --hosts ghast,mcp,mock_l3,search_only --format json
node dist/cli/gmos.js gym run --db :memory: --generated-seeds 3 --format json
node dist/cli/gmos.js gym scale --sizes 100,1000 --threshold-p95-ms 250 --format json
npm pack --dry-run
```

`test:consumer` packs the SDK, installs it into a temporary external project,
then verifies package exports, plaintext SQLite use, the MCP-style router, MCP
stdio server wiring, the HTTP adapter export, and the `gmos` CLI from the
installed package.

The GitHub Actions CI runs these gates on Linux and macOS with Node 20.19 and
Node 24, and on Windows with Node 24. Windows Node 20.19 is not part of the
official CI matrix because the current `better-sqlite3` prebuild coverage can
fall back to native compilation on GitHub-hosted Windows runners. The benchmark
jobs are deterministic SDK gates; they do not call an external LLM.

`gym run` is the deterministic SDK benchmark. It reports hard gates, coverage
layers, a generalization view, roadmap suggestions, and a run manifest. It does
not run an LLM judge and should not be treated as proof of mature digital-twin
capability.

`gmos gate` is the SDK release-candidate gate. It runs deterministic Memory Gym,
the host compatibility gym, the local SQLite scale benchmark, and diagnostics
in one command. By default it uses an in-memory database and does not inspect or
mutate a user's production memory database. The gate intentionally does not
accept a production DB input; use `gym run --db` or `status --db` when you need
to inspect a specific file. The scale sub-check creates and deletes its own
temporary SQLite files under the OS temp directory; it does not read a user's
memory DB. Passing this gate means the SDK's local runtime contract is healthy;
it is still not an external long-term agent benchmark or a proof of mature
digital-twin capability.

## Examples

Run the examples after installing dependencies:

```bash
npm run examples:quickstart
npm run examples:host-adapter
```

`examples/quickstart.mjs` creates a temporary plaintext SQLite store, observes a user
preference, prepares memory context, exercises low-level
`add/update/search/archive`, prints a content-free diagnostics summary, and removes
the temporary database.

`examples/host-adapter.mjs` shows the host migration path: project an existing
host memory snapshot into gmOS, skip secret-like and person-routed memories,
prepare evidence-aware context, and archive stale imported memories on the next
sync. Use this path when the host already has a memory table and needs gmOS as
the context/action runtime without replacing storage in one step.

## Low-Level Compatibility APIs

The primary gmOS integration path is still `observe()` plus `prepareTurn()`.
That path gives the runtime conversation events, privacy mode, task state, and
feedback signals.

`add()`, `update()`, `archive()`, `clear()`, and `search()` exist for lower-level
compatibility cases: importing a known memory from another host, admin/debug
tools, migration scripts, or simple agent runtimes that do not yet expose full
event hooks. They are intentionally not raw database access:

- `add()` records a `sdk.low_level_add` evidence event before creating memory;
- `update()` records a `sdk.low_level_update` evidence event before changing memory;
- `archive()` and `clear()` archive active memories instead of physically deleting rows;
- secret-like content is rejected before it reaches long-term memory;
- `person` memory and `PERSON:`-routed content require `allowPerson: true` on add/update;
- `clear()` requires an explicit filter: `all`, `scope`, or `metadataEquals`;
- `search()` defaults to `purpose: "context"`, which hides sensitive memory
  unless `includeSensitive` is explicitly set and hides person memory unless
  `includePerson` is explicitly set.

```ts
const saved = await memory.add({
  profileId: "local-user",
  kind: "preference",
  content: "我喜欢先讲风险，再给方案。",
});

const matches = await memory.search({
  profileId: "local-user",
  query: "风险 方案",
});

await memory.update({
  profileId: "local-user",
  id: saved.id,
  content: "我喜欢先讲风险，再给方案。",
});

await memory.archive({
  profileId: "local-user",
  id: saved.id,
});
```

## MCP Tools

The alpha SDK exposes both a protocol-neutral in-process router and a real MCP
stdio server through `@ghast/memory/mcp`. Hosts can mount the same tools behind
MCP stdio, HTTP, Electron IPC, or another agent runtime without changing the
memory core.

```ts
import { createMemoryMcpServer } from "@ghast/memory/mcp";

const server = createMemoryMcpServer(memory);
const result = await server.callTool("memory.prepare_context", {
  text: "你知道我什么偏好吗？",
  includeEvidence: true,
});
```

For agent clients that can launch MCP stdio servers:

```bash
gmos mcp serve --db ./gmos.db --profile local
```

Programmatic stdio server:

```ts
import { serveMemoryMcpStdio } from "@ghast/memory/mcp";

const server = await serveMemoryMcpStdio(memory);
await server.close();
```

Current tools are `memory.observe`, `memory.prepare_context`,
`memory.commit_outcome`, `memory.record_feedback`, `memory.forget`, and
`memory.explain_belief`.

## HTTP Adapter

Hosts that cannot embed the Node SDK directly can run gmOS as a local HTTP
service. This adapter reuses the MCP tool router for memory operations, so it
does not bypass the public safety boundary. It defaults to `127.0.0.1` and
does not add auth, TLS, cloud sync, or database encryption.

```ts
import { createMemoryHttpServer } from "@ghast/memory/http";

const server = createMemoryHttpServer({ memory, store, profileId: "local-user" });
const { url } = await server.listen({ port: 4787 });
```

CLI:

```bash
gmos http serve --db ./gmos.db --profile local --port 4787 --host ghast
```

Endpoints:

- `GET /health`
- `GET /status?profileId=local`
- `GET /tools`
- `POST /observe`
- `POST /prepare`
- `POST /commit-outcome`
- `POST /feedback`
- `POST /forget`
- `POST /explain`
- `POST /mcp/call` with `{ "tool": "memory.prepare_context", "args": {} }`

The HTTP adapter intentionally rejects `includeSensitive` on `/prepare` through
the same public-tool contract as MCP. Hosts that need sensitive/admin memory
access should use the in-process SDK with an explicit internal trust boundary.

## Evolution Review

The alpha SDK includes a report-only self-evolution control plane. It reads the
failure log, clusters failures by kind, proposes repair hypotheses, and emits
policy patch candidates. It does not apply patches, roll out changes, or weaken
hard gates.

```ts
import { createEvolutionControlPlane } from "@ghast/memory/evolution";

const evolution = createEvolutionControlPlane({ store, profileId: "local-user" });
const report = await evolution.reviewFailures();
```

CLI:

```bash
gmos evolution report --db ./gmos.db --profile local --format markdown
```

Every proposal in this alpha path is explicitly marked `autoApply=false` and
`autoRollout=false`.

## Diagnostics

Hosts can generate a read-only status report for integration checks and support
bundles. The report includes package version, SQLite schema version, row counts,
failure counts by kind, and optional host compatibility. It does not include
memory content or failure samples.

```ts
import { createMemoryStatusReport } from "@ghast/memory/diagnostics";

const report = await createMemoryStatusReport({
  store,
  profileId: "local-user",
  host: "ghast",
});
```

CLI:

```bash
gmos status --db ./gmos.db --profile local --host ghast --format markdown
```

## Trust Contract

gmOS defaults to a plaintext SQLite database. Security comes from memory policy
and host boundaries, not database encryption:

- secret-like content is not persisted as long-term memory;
- incognito/private events are not promoted to long-term memory;
- ordinary context does not include sensitive memory unless explicitly allowed;
- forget operations archive matching memory and remove it from future context;
- read paths must not write.

SQLite stores include a `gmos_schema_migrations` ledger. `gmos doctor` reports
the current schema version so host applications can verify upgrade state before
running long-lived agents. TypeScript consumers can use the exported
`SqliteMemoryStore` type when they need SQLite-specific diagnostics.

## Host Compatibility

gmOS reports host capability as L0-L4. The SDK can maintain memory state, but a
host must expose the right hooks to preserve full behavior:

- `ghast`: L4, managed memory runtime.
- `mock_l3`: L3, useful for adapter smoke tests.
- `mcp`: L2, useful for tool-based integrations but cannot guarantee full
  directive enforcement.
- `search_only`: L1, recall-only and not a full Memory OS integration.

Run `gmos doctor --host ghast` to inspect capability gaps and hard-gate
coverage.

Run `gmos gym host` to execute the host compatibility gym. Unlike `doctor`,
which is a static capability report, the host gym exercises behavior expected
from each advertised capability: preference memory use, action-policy
directives, forget residue, private-mode exclusion, evidence-aware context, and
MCP sensitive-boundary enforcement. Unsupported capabilities are reported as
`not_applicable` instead of being hidden.

Host adapters can also import existing memory snapshots through
`loadHostMemorySnapshotsIntoStore()` from `@ghast/memory/host`. The importer
defaults to skipping `person` and `secret_like` snapshots before they enter the
gmOS store. It requires a store that implements
`findActiveMemoryByMetadata()` so repeated snapshot imports are idempotent.

Use `syncHostMemorySnapshotsIntoStore()` when the host is sending a full
current snapshot and stale mirror entries should be archived:

```ts
import { syncHostMemorySnapshotsIntoStore } from "@ghast/memory/host";

await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "local-user",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  memories: [
    {
      id: "host-memory-1",
      content: "我喜欢先讲风险。",
      kind: "preference",
      updatedAt: new Date().toISOString(),
    },
  ],
});
```

`loadHostMemorySnapshotsIntoStore()` is append/reuse import.
`syncHostMemorySnapshotsIntoStore()` is import plus stale host-import archive.
Use sync only when the snapshot list represents the host's complete active
memory set for that `profileId` and `sourceType`.

## Status

This is an alpha SDK extraction repository. The first target is a stable local
TypeScript/Node runtime that Ghast Desktop can consume through a host adapter.
