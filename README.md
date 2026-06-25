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
- Safety gates for secret-like content, incognito events, PERSON isolation,
  forgetting, and do-not-push action policies.
- Built-in deterministic Memory Gym smoke benchmark.
- Host compatibility reports for Ghast, MCP, search-only, and mock L3 adapters.
- Host memory snapshot import for adapters that need to project an existing
  memory store into gmOS.
- Host memory snapshot sync for adapters that need stale imported memories
  archived when the host source changes.
- In-process MCP-style tool router for host/agent runtime adapters.
- CLI: `gmos`.

## CLI

```bash
npm install
npm run build

node dist/cli/gmos.js init --db ./gmos.db
node dist/cli/gmos.js doctor --db ./gmos.db --host ghast
node dist/cli/gmos.js observe --db ./gmos.db --profile local --text "我喜欢简洁的中文回答。"
node dist/cli/gmos.js prepare --db ./gmos.db --profile local --text "你之后怎么回答我？"
node dist/cli/gmos.js mcp tools
node dist/cli/gmos.js mcp call --db ./gmos.db --profile local --tool memory.prepare_context --input '{"text":"你之后怎么回答我？"}'
node dist/cli/gmos.js gym run --db :memory: --generated-seeds 3
node dist/cli/gmos.js gym run --generated-seeds 10 --format markdown --report-file ./memory-gym.md
node dist/cli/gmos.js gym scale --sizes 100,1000
node dist/cli/gmos.js gym host --hosts ghast,mcp,mock_l3,search_only --format markdown
```

## QA Gates

```bash
npm run check
npm run test:consumer
```

`test:consumer` packs the SDK, installs it into a temporary external project,
then verifies package exports, plaintext SQLite use, the MCP-style router, and
the `gmos` CLI from the installed package.

`gym run` is the deterministic SDK benchmark. It reports hard gates, coverage
layers, a generalization view, roadmap suggestions, and a run manifest. It does
not run an LLM judge and should not be treated as proof of mature digital-twin
capability.

## MCP-Style Tools

The alpha SDK exposes a protocol-neutral tool router through
`@ghast/memory/mcp`. It is intentionally in-process first: hosts can mount the
same tools behind MCP stdio, HTTP, Electron IPC, or another agent runtime
without changing the memory core.

```ts
import { createMemoryMcpServer } from "@ghast/memory/mcp";

const server = createMemoryMcpServer(memory);
const result = await server.callTool("memory.prepare_context", {
  text: "你知道我什么偏好吗？",
  includeEvidence: true,
});
```

Current tools are `memory.observe`, `memory.prepare_context`,
`memory.commit_outcome`, `memory.record_feedback`, `memory.forget`, and
`memory.explain_belief`.

## Trust Contract

gmOS defaults to a plaintext SQLite database. Security comes from memory policy
and host boundaries, not database encryption:

- secret-like content is not persisted as long-term memory;
- incognito/private events are not promoted to long-term memory;
- ordinary context does not include sensitive memory unless explicitly allowed;
- forget operations archive matching memory and remove it from future context;
- read paths must not write.

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
