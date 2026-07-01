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
- `@ghast/memory/host`: host compatibility, generic agent-turn adapter, and
  snapshot import/export helpers.
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

Hosts with their own entity model can pass an `entityResolver` to both the
SQLite store and runtime facade. This keeps current-state invalidation,
association projection, entity mentions, and evidence explanations aligned
without adding product-specific entity words to gmOS core. Resolver output is
treated as untrusted input; gmOS sanitizes it and falls back to the built-in
resolver when the custom result is unsafe:

```ts
const entityResolver = (input) => {
  if (!input.subject.startsWith("account:")) return null;
  const key = input.subject.slice("account:".length).trim().toLowerCase();
  return {
    canonicalSubject: `account:${key}`,
    originalSubject: input.subject,
    entityKind: "account",
    entityKey: key,
    aliases: [input.subject, key, ...(input.aliases ?? [])],
  };
};

const store = createSqliteMemoryStore({ path: "./gmos.db", entityResolver });
const memory = createMemoryOS({ profileId: "local-user", store, entityResolver });
```

Hosts with a trusted local or host-controlled calendar/task-time parser can pass
`temporal.parser`. The parser returns structured `eventTime`, `eventDate`,
`validFrom`, and `validTo` values; gmOS normalizes them, drops invalid or
secret-like values, and applies the same current/history filtering used for
extractor-supplied temporal fields. Built-in date-text inference is disabled by
default; set `temporal.inferFromText: true` only when the host explicitly wants
gmOS to parse explicit date text during memory writes. Reconstruction query date
text is also disabled by default; set
`reconstruction.inferTemporalCuesFromText: true` only when the host explicitly
wants the conservative built-in date parser for query cues. Relative calendar
phrases should be resolved by the host parser with trusted calendar context.

```ts
const memory = createMemoryOS({
  profileId: "local-user",
  store,
  temporal: {
    parser: ({ content }) =>
      content.includes("billing rollover")
        ? { validFrom: "2026-07-01", validTo: "2026-08-01" }
        : undefined,
  },
});
```

Primary methods:

- `observe(event)`: record a host event, attach evidence, and extract eligible
  long-term memory through a configured structured extractor. Import semantic
  memories explicitly with `add()` when no structured extractor is configured.
  For multi-speaker events, pass `metadata.speaker`, `speakerKind`,
  `speakerAliases`, and `participants`. gmOS trusts `speaker` as a person cue
  only when `speakerKind` is `"person"` or `"human"`; bare speaker labels remain
  source metadata. Participants are stored as non-retrieval entity mentions for
  explanation and audit, not as association cues.
- `createOpenAICompatibleExtractor(options)`: optional structured extractor
  factory for `/chat/completions` compatible providers. The request body stays
  Chat Completions-shaped; response parsing accepts JSON memory payloads from
  message content strings, content parts, top-level `output_text`, or
  `output[].content[].text` returned by compatible proxies. Provider output
  still goes through the normal gmOS candidate validation and safety gates.
- `prepareTurn(input)`: retrieve ordinary context and action policy for the next
  agent turn. This is a read path and must not write.
- `reconstructContext(input)`: run bounded cue/tag/content reconstruction with
  evidence convergence and planner trace metadata.
- `explainEvidencePath(input)`: explain why evidence was selected for a query.
- `commitOutcome(input)`: record task outcome signals. Failed outcomes may pass
  `failureKind`; omitted values default to `task_failure`.
- `recordFeedback(input)`: record user or host feedback into the failure loop.
- `forget(input)`: archive matching memory and remove it from future context.
  Prefer structured `targetTerms` when a host already knows the deletion target;
  `query` remains required as a human-readable request and literal compatibility
  fallback. SQLite hosts can pass `forgetTargetParser` when they want to parse
  natural-language delete commands into structured target terms. Parser
  `undefined` or `null` falls back to literal `query`; parser empty terms archive
  nothing. Empty literal queries also archive nothing.
- `explain(input)`: explain a memory or belief without exposing unsafe content.

Low-level compatibility methods such as `add`, `search`, `history`, `list`,
`get`, `update`, `delete`, `backup`, and `restore` exist for migration,
administration, and host adapters that cannot emit full events yet. Prefer
`observe()` and `prepareTurn()` for agent runtime integration.

## Agent Turn Adapter

`@ghast/memory/host` exports `createAgentMemoryAdapter()` for Node-based agent
runtimes that want the full lifecycle without copying gmOS internals:

```ts
import { createAgentMemoryAdapter } from "@ghast/memory/host";

const adapter = createAgentMemoryAdapter({
  memory,
  profileId: "local-user",
  includeEvidence: true,
  reconstruction: { mode: "shadow", maxSteps: 2 },
});

await adapter.observeMessage({
  role: "user",
  content: "Let's plan the release.",
});

await memory.add({
  profileId: "local-user",
  kind: "preference",
  content: "Release plan response style: summary first, then options.",
});

const turn = await adapter.prepareTurn({
  messages: [{ role: "user", content: "How should we plan this release?" }],
});

// Pass turn.modelMessages to the host's model call.
```

The adapter is framework-agnostic. It does not depend on LangGraph, Vercel AI
SDK, OpenAI Agents SDK, or any other agent runtime. It wraps the same public
gmOS methods: `observe`, `prepareTurn`, `reconstructContext`, `commitOutcome`,
`recordFeedback`, and `forget`.

Advanced hosts can pass `reconstructionIntent` to `reconstructContext()` or
shadow `prepareTurn()` reconstruction when the host/controller already knows the
turn needs procedure, boundary, preference, or current-state evidence. These
structured `queryCues`, `expectedTags`, and required tag groups are the semantic
route contract; gmOS does not infer these route groups from language keyword
lists. Use `recallPurpose: "history"` or `"context"` when the host already knows
whether the turn asks for historical or current state. `queryCues`, expected
tags, and required tag groups may include host-owned route signals. When such a
signal does not appear in the public query, gmOS keeps it as an internal routing
hint and renders `retrieval_hint` in public context, planner traces, and
explain-path output. Sensitive or secret-like cue hints and intent tags are still
ignored, and cue hints are capped before they can enter the reconstruction
frontier.

Hosts with their own entity, calendar, or route parser can configure
`createMemoryOS({ reconstruction: { cueExtractor } })`. The extractor returns
bounded `{ cue, cueKind }` values for query and intermediate evidence text; gmOS
merges them with built-in lexical/date cues and still filters secret-like cues. Use this
to bridge host-owned semantics into reconstruction instead of adding
language-specific cue rules to gmOS core. The extractor is a trusted, synchronous
host callback: gmOS audits its own store read path and sanitizes returned cues,
but it cannot police external side effects inside host callback code.

Hosts can also configure `createMemoryOS({ safety: { sensitivityClassifier } })`
to mark product-specific local terms as `sensitive` or `secret_like`. The
classifier is additive: gmOS still applies the built-in conservative detector and
uses the maximum sensitivity, so the host callback cannot downgrade built-in
secret-like matches. This is the extension point for host-owned safety semantics;
do not add product-specific keyword lists to gmOS core.

Hosts that need to mirror gmOS safety behavior outside the runtime can import
`classifySensitivity`, `isSecretLikeMemoryContent`,
`eligibleForLongTermMemory`, and `redactForReport` from `@ghast/memory` instead
of copying the built-in detector.

## CLI

The npm package exposes these binaries:

- `gmos`
- `ghast-memory`
- `gmos-inspect`

Useful integration commands:

```bash
gmos version --format json
gmos init --db ./gmos.db
gmos doctor --db ./gmos.db --host ghast --format markdown
gmos status --db ./gmos.db --profile local --host ghast --format markdown
gmos add --db ./gmos.db --profile local --kind preference --text "Response style: concise answers."
gmos add --db ./gmos.db --profile local --kind boundary --text "Do not push release announcements without approval."
gmos observe --db ./gmos.db --profile local --text "User opened the release planning thread."
gmos prepare --db ./gmos.db --profile local --text "How should you answer me?"
gmos reconstruct --db ./gmos.db --profile local --text "What is the project next step?"
gmos forget --db ./gmos.db --profile local --query "delete old project" --target-term "old project"
gmos-inspect --db ./gmos.db --profile local --query "project release" --format markdown
gmos gate --generated-seeds 3 --scale-sizes 100,1000 --format markdown
```

`gmos-inspect` emits a content-safe local inspection report. It reports counts,
evidence eligibility/source summaries, row-count summaries, and optional
reconstruction diagnostics without printing memory content, evidence text,
prompt context, table hashes, or private database paths. Use it for support
bundles and local integration checks before building a host UI.

`doctor`, `status`, `gate`, and report-style gym commands support JSON output by
default and markdown output with `--format markdown`. Use `--json-file` and
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
See [MCP and HTTP integration guide](./INTEGRATION_GUIDE.md) for host boundary
selection, lifecycle wiring, and smoke-test commands.

Run `examples/mcp-router.mjs` for a minimal in-process MCP smoke test. The
example validates `memory.runtime_info`, records an ordinary observation through
`memory.observe`, imports an explicit preference memory, prepares
evidence-backed context through `memory.prepare_context`, rejects public
sensitive override switches, explains the evidence path without returning a
prompt block, and deletes its temporary plaintext SQLite database.

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
non-health requests, records an ordinary observation through `/observe`, imports
an explicit preference memory, prepares context through `/prepare`, reads
`/status`, and deletes its temporary plaintext SQLite database.

## Diagnostics Contract

`getGmosRuntimeInfo()`, `gmos version`, `gmos doctor`, `/runtime-info`,
`memory.runtime_info`, and `createMemoryStatusReport()` expose content-free
runtime and integration metadata. They report package, CLI, export, MCP, HTTP,
and local-first trust contract information. They do not include memory text,
failure samples, or table state hashes.
