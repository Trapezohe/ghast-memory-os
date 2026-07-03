# gmOS API Reference

gmOS is a local-first TypeScript memory runtime. Public callers should use the
package exports listed here and avoid importing files under `dist/` or `src/`.

## Package Exports

- `@ghast/memory`: runtime facade, core types, structured extractor factory,
  `runAutopilot()`, `ingestTranscript()`, recall disposition presets, and
  `getGmosRuntimeInfo()`.
- `@ghast/memory/store/sqlite`: SQLite store, opt-in host-driver encryption,
  and profile backup/restore helpers.
- `@ghast/memory/mcp`: in-process MCP-style router and stdio server helpers.
- `@ghast/memory/http`: local HTTP adapter.
- `@ghast/memory/client`: zero-dependency fetch client for browser, edge, and
  other-process Node callers.
- `@ghast/memory/host`: host compatibility, generic agent-turn adapter, and
  snapshot import/export helpers.
- `@ghast/memory/diagnostics`: read-only status reports.
- `@ghast/memory/gym`: deterministic gates and benchmark adapters.
- `@ghast/memory/evolution`: approval-gated failure review and SDK admin apply/revert control plane.
- `@ghast/memory/intelligence`: opt-in OpenAI-compatible hook factories and
  `createDefaultIntelligence()`.

## Client Packages

The JS/TS client is exported as `@ghast/memory/client` and ships in the npm
tarball. It uses global `fetch`, accepts an injected `fetchImpl`, and maps every
public HTTP route in the OpenAPI snapshot.

The Python client lives under `python/gmos_client`. It is stdlib-only
(`urllib`) and version-checked against `package.json`, but it is not included in
the npm tarball.

## Runtime Facade

Create the runtime with an explicit store:

```ts
import { createMemoryOS } from "@ghast/memory";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const store = createSqliteMemoryStore({ path: "./gmos.db" });
const memory = createMemoryOS({ profileId: "local-user", store });
```

### SQLite Store Encryption

`createSqliteMemoryStore()` is plaintext by default. Hosts can opt in to
encryption at rest by supplying a BetterSqlite3-compatible cipher driver:

```ts
import CipherDatabase from "better-sqlite3-multiple-ciphers";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const store = createSqliteMemoryStore({
  path: "./gmos.db",
  encryption: {
    driver: CipherDatabase,
    key: process.env.GMOS_DB_KEY ?? "",
    pragmas: ["PRAGMA cipher = 'sqlcipher'"],
  },
});
```

gmOS does not depend on a cipher package and does not own key custody. The key is
used only during store open: gmOS validates that it is non-empty and contains no
quotes or control characters, applies `PRAGMA key`, applies host-supplied cipher
pragmas before schema setup, verifies the database is readable, and then runs
normal schema initialization. `handle` and `encryption` are mutually exclusive
because gmOS must open the database through the supplied driver.

The store exposes `encryptionStatus()`:

```ts
store.encryptionStatus(); // { encrypted: true, mode: "host_driver" }
```

Failures throw `SqliteMemoryStoreEncryptionError` with one of these codes:

- `encryption_handle_conflict`
- `invalid_encryption_key`
- `encryption_open_failed`
- `encryption_key_failed`
- `encryption_verify_failed`

Open failures close the driver handle and do not remove pre-existing database,
WAL, or SHM files. Files created during a failed new encrypted open are cleaned
up best-effort.

Profile backup/restore methods run through the already opened store handle. For
encrypted stores, source reads and restore writes therefore use the host-supplied
driver and key. The profile backup document remains JSON and should be protected
by the host when written to disk.

### Embedding Provider And Retrieval

Hosts may pass `embeddingProvider` to `createMemoryOS()` or
`createSqliteMemoryStore()`:

```ts
const embeddingProvider = {
  name: "local-onnx-bge-small",
  dimensions: 384,
  async embed(texts: string[]) {
    return texts.map((text) => embedLocally(text));
  },
};

const store = createSqliteMemoryStore({ path: "./gmos.db", embeddingProvider });
const memory = createMemoryOS({
  profileId: "local-user",
  store,
  embeddingProvider,
  retrieval: {
    fusion: { fts: 1, vector: 1.2, association: 0.8 },
    reranker: async (candidates) => candidates.map((candidate) => candidate.id),
  },
});
```

The provider receives batch input and returns order-preserving vectors with
finite numbers and the configured dimension. gmOS normalizes vectors before
storage. Provider failures do not block writes; gmOS stores a `local-hash-v1`
fallback vector with pending status and explicit repair can backfill it.

By default, only normal non-`person` memories are sent to the provider.
`{ provider, embedSensitive: true }` and `{ provider, embedPerson: true }` are
host opt-ins. Secret-like content and secret-like queries are never sent.

Read paths do not call the provider unless the host explicitly enables query
embedding:

```ts
await memory.search({
  query: "semantic paraphrase",
  retrieval: { embedQuery: true, queryEmbeddingTimeoutMs: 1000 },
});
```

The same `retrieval` read option is available on `prepareTurn()` and
`reconstructContext()`. Without it, provider-backed stores still use lexical FTS
and local fallback vectors on reads.

### Recall Disposition Presets

`createMemoryOS({ disposition })` sets a default recall disposition for
`prepareTurn()`, `explainTurn()`, `reconstructContext()`, and
`explainEvidencePath()`. Each call can override it with `dispositionPreset`.

Supported presets are:

- `focused`: tighter context/search/planner budgets and a higher score
  threshold;
- `balanced`: current defaults;
- `expansive`: larger budgets, lower score threshold, and history recall where
  reconstruction calls allow it.

Presets do not affect sensitivity, person, incognito, lifecycle, or forgetting
gates. `explainTurn()` reports the effective preset in `budgets.dispositionPreset`.

Scoped HTTP API keys can carry a default disposition:

```bash
gmos keys create \
  --db ./gmos.db \
  --label planner-read \
  --scope read \
  --profiles local \
  --default-disposition focused
```

Lifecycle maintenance is configured on the runtime facade and runs only when the
host explicitly calls `maintain()`:

```ts
const memory = createMemoryOS({
  profileId: "local-user",
  store,
  lifecycle: {
    enabled: true,
    dormantBelow: 0.25,
    archiveAfterDormantDays: 180,
    halfLivesDays: { project: 90 },
    outcomeReinforcement: { enabled: true, step: 0.1 },
    feedbackConfidencePenalty: { enabled: true, step: 0.1, floor: 0.05 },
    confidenceAnnealing: {
      enabled: true,
      windowMs: 60 * 60 * 1000,
      boostThreshold: 2,
      confidenceCap: 0.6,
      retentionCap: 0.45,
    },
  },
  consolidation: {
    enabled: true,
    tagOverlapThreshold: 0.6,
    duplicateMinClusterSize: 2,
    hookMinClusterSize: 3,
    maxClustersPerRun: 10,
    maxMembersPerCluster: 8,
    eligibleKinds: ["task_trajectory", "fact", "project"],
  },
  distillation: {
    enabled: true,
    minRepeats: 3,
    maxClustersPerRun: 10,
    maxTrajectoriesPerCluster: 8,
  },
  dossier: {
    enabled: true,
    minBeliefs: 1,
    minLinkedMemories: 2,
    maxEntitiesPerRun: 8,
    maxBeliefsPerEntity: 8,
    maxMemoriesPerEntity: 8,
  },
});
```

Default half-lives are `fact=180`, `preference=365`, `project=90`,
`procedure=365`, and `task_trajectory=45` days. `boundary` and `person` memories
are exempt from automatic lifecycle transitions unless the host explicitly
provides `autoTransitionKinds` with those kinds included. Person memories keep
the normal person isolation gates even if opted in.

Confidence annealing is on by default. Rapid reinforcement from non-independent
evidence within `windowMs`, and memories written from lower-trust sources, carry
`metadata.annealing`; search, ranking, retention, `prepareTurn()`, and
`explainTurn()` use the capped effective confidence and expose the annealing
state in score components.

Consolidation defaults are shown above. `enabled: false` disables the
`consolidate` phase even when requested. The tag-overlap threshold is clamped to
`0..1`; cluster counts and member counts are positive integers. Duplicate
consolidation always excludes `boundary`, `person`, archived, sensitive, and
secret-like memories. Host semantic consolidation additionally uses
`eligibleKinds`, defaulting to episodic-leaning `task_trajectory`, `fact`, and
`project`.

Dossier defaults are shown above. `enabled: false` disables the `dossier` phase
even when requested. Dossiers are synthesized only from active world beliefs plus
linked source memories selected by gmOS; the hook receives bounded snapshots and
gmOS owns persistence, supersession, PERSON isolation, secret-like rejection, and
forget residue cleanup.

Outcome reinforcement defaults to enabled with `step: 0.1`. Completed outcomes
add the step to each `usedMemoryIds` memory; failed outcomes with
`failureKind: "wrong_recall"` or `"missed_recall"` subtract it. Reinforcement is
bounded to `[-1, 1]` and affects retention. Feedback confidence penalty defaults
to enabled with `step: 0.1` and `floor: 0.05`; `wrong_recall` feedback lowers
related memory confidence, which affects ranking.

Procedure distillation defaults are shown above. `enabled: false` disables the
`distill` phase even when requested. Counts are positive integers. Only
completed task trajectories are eligible; failed trajectories never count.

### Transcript Ingestion

`ingestTranscript()` maps structured transcript exports into ordinary
`observeWithReport()` calls:

```ts
import { ingestTranscript } from "@ghast/memory";

await ingestTranscript({
  memory,
  profileId: "local-user",
  inputFile: "./thread.jsonl",
  format: "jsonl",
  dryRun: true,
});
```

Formats:

- `jsonl`: one `{ role, content, createdAt?, metadata? }` object per line;
- `claude-code`: Claude Code transcript JSONL; user and assistant text messages
  are imported, tool calls/results and system noise are skipped;
- `openai-thread`: exported messages array, or `{ messages }`/`{ data }`, with
  `role`, `content`, and `created_at`.

The source file content hash and record index become stable message ids, so
re-running the same file deduplicates at `observe()` event-key level. Ingestion
metadata stores the file hash, not the absolute path. No linguistic extraction
is done by ingestion itself; any durable memory extraction comes from the
runtime extractor already configured by the host.

### Autopilot

`runAutopilot()` is a one-shot host-scheduled composition of existing explicit
write paths:

```ts
import { runAutopilot } from "@ghast/memory";

const report = await runAutopilot({
  store,
  memory,
  profileId: "local-user",
  ingest: { dir: "./transcripts" },
  embedBackfill: { batchSize: 32 },
  phases: ["decay", "consolidate"],
  dryRun: true,
});
```

Execution order is transcript ingestion, embedding/search-index backfill, then
`maintain()`. Dry-run threads through every step and writes nothing. Non-dry-run
stores a content-free row in `gmos_autopilot_runs` when the SQLite store is
used. The stored report includes ids, reasons, counts, timings, and phase
summaries; memory content and transcript content are not stored in the run
history. Autopilot never runs evolution apply.

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
- `@ghast/memory/intelligence`: opt-in subpath exporting
  `createOpenAICompatibleExtractor`, `createOpenAICompatibleConsolidator`,
  `createOpenAICompatibleProcedureDistiller`,
  `createOpenAICompatibleDossierSynthesizer`,
  `createOpenAICompatibleEmbeddingProvider`,
  `createOpenAICompatibleReranker`, and `createDefaultIntelligence`. Every
  factory accepts an injectable `fetchImpl`, uses OpenAI-compatible HTTP shapes,
  and is loaded only when the host imports the subpath.
- `prepareTurn(input)`: retrieve ordinary context and action policy for the next
  agent turn. This is a read path and must not write.
- `explainTurn(input)`: run the same retrieval and context-budget pipeline as
  `prepareTurn()` in explanation mode. It returns included and excluded memory
  decision traces but no context block for prompt injection.
- `reconstructContext(input)`: run bounded cue/tag/content reconstruction with
  evidence convergence and planner trace metadata.
- `explainEvidencePath(input)`: explain why evidence was selected for a query.
- `commitOutcome(input)`: record task outcome signals. Failed outcomes may pass
  `failureKind`; omitted values default to `task_failure`. Hosts should pass
  memory ids used in the turn as `usedMemoryIds`; gmOS increments recall
  counters, sets `lastRecalledAt`, reactivates dormant memories, and applies
  bounded outcome reinforcement in the same write transaction.
- `recordFeedback(input)`: record user or host feedback into the failure loop.
  Pass `relatedMemoryIds` plus `signal: "positive" | "negative"` to adjust
  memory `reinforcement` by a deterministic bounded step within `[-1, 1]`.
  `wrong_recall` feedback with `relatedMemoryIds` also lowers confidence down to
  the configured floor. Confidence affects ranking; reinforcement affects
  retention.
- `maintain(input)`: explicit lifecycle write path. `dryRun: true` computes the
  full report and writes nothing. Pass `phases: ["consolidate"]`,
  `["distill"]`, `["dossier"]`, or combinations such as
  `["decay", "consolidate", "distill", "dossier"]` to run duplicate
  consolidation, optional host semantic consolidation, optional host procedure
  distillation, and optional entity dossier synthesis. Ordinary runtime reads
  never call this automatically.
- `forget(input)`: archive matching memory and remove it from future context.
  Prefer structured `targetTerms` when a host already knows the deletion target;
  `query` remains required as a human-readable request and literal compatibility
  fallback. SQLite hosts can pass `forgetTargetParser` when they want to parse
  natural-language delete commands into structured target terms. Parser
  `undefined` or `null` falls back to literal `query`; parser empty terms archive
  nothing. Empty literal queries also archive nothing.
- `memoryRollback(input)`: replay a memory evidence ledger and restore the memory
  as of `toEvidenceEventId`. The call requires `{ memoryId, toEvidenceEventId,
  approvedBy }` and writes a `memory.rollback` evidence event with its own
  `previousValues`, so rollback writes are themselves auditable. Histories that
  predate M13 and lack sufficient `previousValues` fail with a typed
  `MemoryRollbackError`. Rollback is an SDK/CLI admin operation like evolution
  apply: it is intentionally absent from the MCP and HTTP public surfaces.
- `explain(input)`: explain a memory or belief without exposing unsafe content,
  including a lifecycle history derived from evidence and feedback events.

`observe()` accepts `sourceTrust?: "user" | "agent" | "external"` and
`allowLowerTrustPolicyWrites?: boolean`. Defaults preserve existing behavior:
user-role messages are user trust, assistant/tool/summary/note messages are
agent trust, and foreign imports default to external trust. Agent/external
candidates get capped confidence, are annealed by default, cannot create
boundary/procedure policy memories without an explicit override, and cannot
supersede higher-trust single-cardinality world beliefs.

`forget()` now also redacts source evidence content when every memory derived
from that evidence event has been forgotten. The evidence row, id, source type,
and payload remain, but readable content is replaced with a sha256/length stub.
If another active or dormant memory still points at the same evidence event,
the evidence content is not redacted until that survivor is also forgotten.

Low-level compatibility methods such as `add`, `search`, `history`, `list`,
`get`, `update`, `delete`, `backup`, and `restore` exist for migration,
administration, and host adapters that cannot emit full events yet. Prefer
`observe()` and `prepareTurn()` for agent runtime integration.

`PreparedTurn.memories` contains the memory ids selected for ordinary context.
Hosts should pass the ids actually used by the model/tool loop back through
`commitOutcome({ usedMemoryIds })`.

## Turn Explanation

`explainTurn(input)` accepts the same input shape as `prepareTurn(input)` plus
`maxExcluded?: number`. It is a read path and is covered by the same read-audit
snapshot checks as `prepareTurn()`. The runtime shares the retrieval, safety
gating, action-policy, reconstruction-shadow, and token-budget code path with
`prepareTurn()`; trace collection is only attached for explanation mode.

```ts
const explanation = await memory.explainTurn({
  profileId: "local-user",
  messages: [{ role: "user", content: "How should we plan this release?" }],
  contextBudgetTokens: 800,
  maxExcluded: 20,
});
```

The report schema is `gmos.turn_explanation.v1`:

```ts
{
  schema: "gmos.turn_explanation.v1",
  profileId,
  query,
  included: [{
    id,
    kind,
    status,
    content,
    retention: { recallCount?, reinforcement?, confidence },
    cues,
    associations,
    tags,
    scoreComponents: { confidence, retrievalScore, contentScore, finalScore },
    evidenceEventIds,
  }],
  excluded: [{
    id,
    kind,
    status,
    reason,
    retention: { recallCount?, reinforcement?, confidence },
    cues,
    associations,
    tags,
    scoreComponents,
  }],
  budgets: {
    memorySearchLimit,
    contextBudgetTokens,
    promptTokenEstimate,
    actionPolicyCount,
    planner?: { maxSteps, maxBranch, maxMemories, stopReason },
    stoppedAt,
  },
  stats,
}
```

`stats` has parity with `PreparedTurn.stats`; `included` matches
`PreparedTurn.memories` for the same input and store state. The report never
includes `contextBlock`. Included memory content follows the same visibility
rules as the context itself. Excluded candidates expose only content-safe
decision fields and do not include memory text.

`reason` is a closed enum:

```ts
type TurnExplanationExcludedReason =
  | "dormant"
  | "archived"
  | "superseded"
  | "out_of_window"
  | "sensitivity_gated"
  | "person_gated"
  | "incognito_gated"
  | "forget_residue"
  | "budget_cut"
  | "below_score_threshold"
  | "deduplicated";
```

`stoppedAt` is `"memory_search" | "token_budget" | "planner" | "complete"`.
`budget_cut` covers candidates considered by the retrieval pipeline but omitted
by memory-search or context-token budgets.

## Memory Lifecycle

`MemoryStatus` is `active | dormant | archived`.

- `active`: eligible for ordinary context, action policy projection, history
  recall, and management operations.
- `dormant`: excluded from ordinary `prepareTurn()` and
  `reconstructContext({ recallPurpose: "context" })` like archived memory, but
  reachable through history-purpose recall and status-filtered `list({ status:
  "dormant" })` or `list({ status: "any" })`.
- `archived`: excluded from ordinary and history recall unless explicitly
  listed/restored through management APIs.

`explain(id)` now includes a lifecycle history section:

```ts
{
  lifecycle: {
    schema: "gmos.memory_lifecycle_history.v1",
    entries: [{
      createdAt,
      eventKind,
      eventId?,
      sourceType?,
      fromStatus?,
      toStatus?,
      reasonSummary,
    }],
  },
}
```

`eventKind` can be `created`, `imported`, `updated`, `reinforced`,
`decayed_to_dormant`, `archived`, `consolidated_source`,
`consolidated_survivor`, `consolidated_summary`, `distilled_source_trajectory`,
`distilled_procedure`, `evolution_applied`, `evolution_reverted`, `forgotten`,
`restored`, or `reactivated`. Entries are ordered by `createdAt` and derived
from existing evidence/failure payloads; gmOS does not add schema fields or
write new rows for lifecycle explanation. Reason summaries and ids are
content-safe redacted strings.

`maintain({ profileId, dryRun, now, phases })` defaults to
`phases: ["decay"]` and returns:

```ts
{
  schema: "gmos.maintenance_report.v1",
  profileId,
  now,
  dryRun,
  evaluated,
  transitions: [
    { memoryId, kind, from, to, retention, reasons }
  ],
  exempted,
  skipped,
  consolidation: {
    enabled,
    evaluated,
    duplicateClusters: [
      { kind, survivorId, memberIds, archivedMemberIds, reasons }
    ],
    summaryMemories: [
      { kind, sourceMemoryIds, sharedTags, content, confidence, memoryId?, worldBeliefId?, reasons }
    ],
    rejectedCandidates: [
      { kind, sourceMemoryIds, reason }
    ],
    skipped
  },
  distillation: {
    enabled,
    evaluated,
    clusters: [
      { objective, sourceTrajectoryIds, sharedTags, clusterKey }
    ],
    summaryMemories: [
      { sourceTrajectoryIds, objective, sharedTags, content, confidence, memoryId?, reasons }
    ],
    rejectedCandidates: [
      { sourceTrajectoryIds, reason }
    ],
    skipped
  },
  dossier: {
    enabled,
    evaluated,
    entities: [
      { entityKey, kind, sourceBeliefIds, sourceMemoryIds }
    ],
    summaryMemories: [
      { entityKey, kind, sourceBeliefIds, sourceMemoryIds, content, confidence, memoryId?, supersededMemoryId?, reasons }
    ],
    rejectedCandidates: [
      { entityKey, kind, sourceBeliefIds, sourceMemoryIds, reason }
    ],
    skipped
  }
}
```

Applied transitions write one evidence event with `sourceType: "maintenance"`
and `eligibleForLongTermMemory: false`. Dormant reactivation from
`commitOutcome({ usedMemoryIds })` writes a lifecycle evidence event with
`sourceType: "memory.lifecycle"`. Maintenance is idempotent for the same `now`:
after a transition is applied, a second run sees the new status and produces no
duplicate transition.

Duplicate consolidation runs inside `maintain()` and is deterministic. It scans
active and dormant memories per profile/kind, excludes `boundary`, `person`,
archived, sensitive, and secret-like rows, clusters near duplicates by
normalized content equality/containment plus tag overlap, keeps the canonical
survivor by highest confidence, newest `updatedAt`, then lexicographic id, and
archives the other members. The survivor content is never rewritten. Archived
members receive `metadata.supersededBy`; each archive writes a
`sourceType: "consolidation"` evidence event with `eligibleForLongTermMemory:
false` and payload fields `survivorId`, `memberIds`, `archivedMemberId`, and
`reasons`.

Host semantic consolidation is optional:

```ts
const memory = createMemoryOS({
  profileId: "local-user",
  store,
  consolidator: {
    name: "host-consolidator",
    consolidate(cluster) {
      return [{
        kind: "project",
        content: "project:vega release is ready after repeated dry-run notes.",
        confidence: 0.84,
        subject: "project:vega",
        predicate: "project.state",
        object: "ready_after_dry_runs",
      }];
    },
  },
});
```

The consolidator input is `{ kind, sharedTags, memories }`, where `memories` is
a bounded sanitized snapshot of `{ id, kind, content, confidence, createdAt,
updatedAt }`. Returning `null` or throwing means no summary for that cluster.
gmOS rejects empty, overlong, duplicate, PERSON-routed, person-kind, or
secret-like candidates, clamps confidence to `0..1`, and never synthesizes
summary text itself. Accepted summaries are stored as new memories whose source
evidence has `sourceType: "consolidation"` and payload `sourceMemoryIds`; source
memories are marked dormant with lifecycle evidence and `metadata.consolidatedInto`.
If the candidate includes `subject`, `predicate`, and `object`, gmOS writes the
corresponding world belief with the summary memory as source.

Host procedure distillation is optional:

```ts
const memory = createMemoryOS({
  profileId: "local-user",
  store,
  procedureDistiller: {
    name: "host-procedure-distiller",
    distill(cluster) {
      return [{
        content: "For Vega releases, verify the audit trail before shipping.",
        confidence: 0.82,
      }];
    },
  },
});
```

The distiller input is `{ objective, sharedTags, trajectories }`, where
`trajectories` is a bounded sanitized snapshot of `{ id, objective, status,
summary?, createdAt }`. Returning `null`, `[]`, or throwing means no procedure
for that cluster. gmOS rejects empty, overlong, duplicate, PERSON-routed, or
secret-like candidates, clamps confidence to `0..1`, and never synthesizes
procedure prose itself. Accepted candidates are stored as `kind: "procedure"`
memories whose source evidence has `sourceType: "distillation"`,
`eligibleForLongTermMemory: false`, and payload `sourceTrajectoryIds`. Source
trajectories are not archived or modified.

Entity dossier synthesis is optional:

```ts
const memory = createMemoryOS({
  profileId: "local-user",
  store,
  dossierSynthesizer: {
    name: "host-dossier-synthesizer",
    synthesize(entity) {
      return {
        content: `${entity.entityKey} dossier: current public state is summarized from cited beliefs.`,
        confidence: 0.82,
      };
    },
  },
});
```

Run it with `maintain({ phases: ["dossier"] })`. gmOS selects entities with
enough active world beliefs and linked memories, calls the hook with bounded
belief and memory snapshots, rejects empty, overlong, secret-like, or
wrongly PERSON-routed output, and stores one active dossier per entity. A new
dossier archives the previous active dossier for the same `metadata.dossierFor`
key and records `sourceType: "dossier"` evidence with `sourceBeliefIds` and
`sourceMemoryIds`. Person subjects produce `kind: "person"` dossiers; project
subjects produce `kind: "project"` dossiers; other subjects produce
`kind: "fact"` dossiers.

The retention score is pure and deterministic:

```text
anchor = lastRecalledAt ?? updatedAt ?? createdAt
recency = 0.5 ^ (ageDays(anchor, now) / halfLifeDays[kind])
recall = min(1, log1p(recallCount) / log1p(20))
reinforcement01 = (clamp(reinforcement, -1, 1) + 1) / 2
score = clamp(recency * 0.6 + confidence * 0.2 + recall * 0.1 + reinforcement01 * 0.1, 0, 1)
```

`now` is an explicit parameter to `maintain()` and `retentionScore()`. The
runtime default is the call time for that explicit write path; read paths never
score or transition memory in the background.

## Evolution Proposals

`createEvolutionControlPlane({ store, profileId })` returns an approval-gated
admin control plane. `reviewFailures()` is read-only and returns deterministic
clusters, hypotheses, and patch proposals whose ids are stable hashes of the
normalized cluster signature.

```ts
const evolution = createEvolutionControlPlane({ store, profileId: "local-user" });
const report = await evolution.reviewFailures();
const proposal = report.patchProposals[0];

const application = await evolution.applyEvolutionProposal({
  proposalId: proposal.id,
  approvedBy: "Song Su",
});

await evolution.revertEvolutionApplication({
  applicationEventId: application.applicationEventId,
});
```

`approvedBy` is required and non-empty. Actions default to the proposal's
suggested actions; callers may pass a subset of those actions but cannot add new
targets or wider mutations. The action set is limited to bounded reinforcement
adjustment, bounded confidence adjustment, demote to dormant, and reactivate.
Every apply writes `sourceType: "evolution"` evidence with `{ proposalId,
approvedBy, actions, previousValues }`; revert restores `previousValues`, writes
its own evolution evidence, and a second revert fails with a typed
`EvolutionApplicationError`.

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

## Gym And Benchmark APIs

`@ghast/memory/gym` exports the deterministic SDK gates and external adapter
runners that ship in the npm package. They run in-process against public gmOS
APIs and do not require repository-relative paths or dev dependencies.

Common exports:

- `runMemoryGym()` and `renderMemoryGymMarkdown()`;
- `runExperienceHorizonGym()` for the M6a multi-week experience-learning
  scenario group;
- `runMemoryReleaseGate()` and `runMemoryScaleBenchmark()`;
- `runHostCompatibilityGym()`;
- `runExternalMemoryBenchmark()` and `runExternalMemoryBenchmarkSuite()`;
- dataset helpers such as `parseExternalMemoryBenchmarkDataset()`,
  `parseExternalMemoryBenchmarkJsonl()`,
  `parseExternalMemoryBenchmarkSuite()`, and
  `hashExternalMemoryBenchmarkInput()`.

Important report and option types include `MemoryGymResult`,
`MemoryGymExperienceHorizonReport`, `ExternalMemoryBenchmarkResult`,
`ExternalMemoryBenchmarkProtocol`, `ExternalMemoryBenchmarkJudge`,
`ExternalMemoryBenchmarkJudgeResult`,
`ExternalMemoryBenchmarkJudgeProvenance`,
`ExternalMemoryBenchmarkSuiteResult`, and
`ExternalMemoryBenchmarkSuiteExecution`.

External benchmark protocol handling is explicit:

```ts
import { runExternalMemoryBenchmark } from "@ghast/memory/gym";

const localReport = await runExternalMemoryBenchmark({
  cases,
  protocol: "deterministic_local",
});

const officialReport = await runExternalMemoryBenchmark({
  cases,
  protocol: "official_protocol",
  judge: {
    name: "host-judge-v1",
    judge(question, expectedAnswer, actualAnswer) {
      return { correct: hostCheck(question, expectedAnswer, actualAnswer) };
    },
  },
});
```

`deterministic_local` is the default and remains fully offline. An
`official_protocol` run requires a host-provided judge; without one the runner
throws instead of falling back to lexical scoring. The judge callback receives
only benchmark dataset content (`question`, `expectedAnswer`) and the answer
text produced by the runtime (`actualAnswer`). It does not receive gmOS memory
ids, evidence ids, profile ids, store handles, or private memory metadata.

## CLI

The npm package exposes these binaries:

- `gmos`
- `ghast-memory`
- `gmos-inspect`

`ghast-memory` is an alias for `gmos`; `gmos-inspect` is the read-only
inspection binary.

Useful integration commands:

```bash
gmos version --format json
gmos init --db ./gmos.db
gmos doctor --db ./gmos.db --host ghast --format markdown
gmos status --db ./gmos.db --profile local --host ghast --format markdown
gmos maintain --db ./gmos.db --profile local --dry-run --phases decay,consolidate,distill,dossier --format markdown
gmos add --db ./gmos.db --profile local --kind preference --text "Response style: concise answers."
gmos add --db ./gmos.db --profile local --kind boundary --text "Do not push release announcements without approval."
gmos observe --db ./gmos.db --profile local --text "User opened the release planning thread."
gmos prepare --db ./gmos.db --profile local --text "How should you answer me?"
gmos reconstruct --db ./gmos.db --profile local --text "What is the project next step?"
gmos forget --db ./gmos.db --profile local --query "delete old project" --target-term "old project"
gmos rollback --db ./gmos.db --profile local --memory memory_xxx --to evidence_xxx --approved-by "Song Su" --yes
gmos snapshot create --db ./gmos.db --profile local --name before-migration --snapshots-dir ./snapshots
gmos snapshot list --db ./gmos.db --profile local
gmos repair --db ./gmos.db --search-index --dry-run --vector-batch-size 32
gmos evolution report --db ./gmos.db --profile local --format markdown
gmos evolution apply --db ./gmos.db --profile local --proposal proposal_xxx --approved-by "Song Su" --yes
gmos evolution revert --db ./gmos.db --application evidence_xxx --yes
gmos-inspect --db ./gmos.db --profile local --query "project release" --temporal-mode current --evidence-limit 50 --failure-limit 50 --max-steps 2 --max-branch 4 --format markdown
gmos-inspect turn --db ./gmos.db --profile local --query "project release" --max-excluded 20 --format markdown
gmos-inspect timeline <memory-id> --db ./gmos.db --profile local --format markdown
gmos gate --generated-seeds 3 --scale-sizes 100,1000 --format markdown
```

Value-taking CLI options use the next space-separated token as the value. If
that token is missing or starts with `--`, gmOS reports `<option> requires a
value`. For path option values whose filename starts with `--`, pass
`./--report.json` or an absolute path.

`doctor` and `status` include `storage.searchIndex.vectorIndex` with
`providerName`, `providerDimensions`, `embeddedEntryCount`,
`pendingEntryCount`, and `staleProviderEntryCount`. `repairSearchIndex({
dryRun, vectorBatchSize })` rebuilds FTS and backfills pending/stale vectors in
a bounded batch; dry-run reports the same shape without writes.

`gmos-inspect` emits content-safe local inspection reports. The default report
prints counts, evidence eligibility/source summaries, row-count summaries,
failure kind summaries, forget residue counts for archived-memory derived
world-belief/association residue, and optional reconstruction diagnostics. Use
`--temporal-mode current` or `--temporal-mode history` when inspecting
current-state or historical recall behavior. Use `--failure-limit` to cap
inspected failure events. The `turn` view renders the `explainTurn()` report for
one query; the `timeline` view renders the lifecycle history for one memory id.
Inspector reports do not print memory content, evidence text, raw query
secrets, profile IDs, prompt context, table hashes, or private database paths.
Use them for support bundles and local integration checks before building a host
UI.
Use `--evidence-limit` to cap evidence summary sampling. Use `--max-steps` and
`--max-branch` to bound optional reconstruction diagnostics for query-based
inspection, including reconstruction step, explored cue, and association counts.

`doctor`, `status`, `gate`, and report-style gym commands support JSON output by
default and markdown output with `--format markdown`. `status` includes
read-only lifecycle counts plus `consolidationEvidenceCount` and
`lastConsolidationAt` when consolidation evidence exists. Use `--json-file` and
`--markdown-file` on commands that expose those artifact flags when building
reproducibility bundles.

## MCP Surface

The MCP-style surface exposes public tools for hosts that integrate by tool
calls instead of direct SDK imports:

- `memory.add`
- `memory.search`
- `memory.observe`
- `memory.prepare_context`
- `memory.explain_turn`
- `memory.reconstruct_context`
- `memory.explain_evidence_path`
- `memory.commit_outcome`
- `memory.record_feedback`
- `memory.maintain`
- `memory.forget`
- `memory.explain_belief`
- `memory.runtime_info`

Public MCP tools intentionally do not expose sensitive override switches.
`memory.maintain` accepts optional
`phases: ["decay" | "consolidate" | "distill" | "dossier"]`; the local HTTP
`POST /maintain` route reuses the same validation. Evolution apply/revert is not
exposed over MCP or HTTP; it is SDK/CLI admin-only.
See [MCP and HTTP integration guide](./INTEGRATION_GUIDE.md) for host boundary
selection, lifecycle wiring, and smoke-test commands.

Run `examples/mcp-router.mjs` for a minimal in-process MCP smoke test. The
example validates `memory.runtime_info`, records an ordinary observation through
`memory.observe`, imports an explicit preference memory, prepares
evidence-backed context through `memory.prepare_context`, rejects public
sensitive override switches, explains the turn and evidence path without
returning a prompt block, records task outcome and feedback failures, and
deletes its temporary plaintext SQLite database.

## HTTP Surface

The local HTTP adapter exposes:

- `GET /health`
- `GET /healthz`
- `GET /runtime-info`
- `GET /tools`
- `GET /status`
- `GET /openapi.json`
- `GET /profiles` (admin scope)
- `POST /profiles` (admin scope; create/ensure only)
- `GET /keys` (admin scope; no hashes or secrets)
- `GET /evolution/review` (admin scope; read-only)
- `POST /add`
- `POST /search`
- `POST /observe`
- `POST /prepare`
- `POST /explain-turn`
- `POST /reconstruct`
- `POST /explain-path`
- `POST /commit-outcome`
- `POST /feedback`
- `POST /maintain`
- `POST /forget`
- `POST /explain`
- `POST /mcp/call`

`gmos serve` is the hardened service command. `gmos http serve` remains a
compatibility alias. Defaults stay local-first: `--host-iface` defaults to
`127.0.0.1`, and binding to a non-loopback interface requires
`--allow-non-loopback`. Useful service flags are `--keys`, `--cors-origin`,
`--rate-limit`, `--audit-retention-days`, and `--console`.

`--console` serves the packaged static console at `/console/`. Static console
assets are GET-only and unauthenticated because the shell contains no data. Data
requests made by the browser still use ordinary HTTP routes with
`Authorization: Bearer <key>` and are audited like any other service request.
Console responses include `Content-Security-Policy: default-src 'self';
connect-src 'self'`, `X-Content-Type-Options: nosniff`, and
`Referrer-Policy: no-referrer`; scripts and styles are separate local files.

Without `--keys`, legacy bearer mode keeps `GMOS_HTTP_AUTH_TOKEN` /
`--auth-token` behavior for existing local adapters. With `--keys`, auth uses
SQLite-backed scoped API keys:

- `read`: `/status`, `/openapi.json`, tools/runtime info, search, prepare,
  reconstruct, explain routes.
- `readwrite`: `read` plus add, observe, commit outcome, feedback, maintain,
  and forget.
- `admin`: `readwrite` plus profile management, key listing, and
  `/evolution/review`.

Key creation and revocation are CLI-only:

```bash
gmos keys create --db ./gmos.db --label claude-code --scope readwrite --profiles local
gmos keys create --db ./gmos.db --label no-history --scope read --profiles local --no-history-access
gmos keys list --db ./gmos.db
gmos keys revoke --db ./gmos.db --key-id key_xxx
```

Secrets are printed once at creation and stored only as sha256 hashes. Key
records are `{ keyId, label, scope, profiles, defaultDisposition?,
historyAccess, createdAt, revokedAt? }`; `list` and HTTP `/keys` never return
`hash` or the secret. `--no-history-access` sets `historyAccess: false`, which
blocks history-purpose search/reconstruction and archived/dormant visibility
over HTTP. Profile allowlist failures return `403 profile_forbidden`
consistently.

The service audit log is content-free: key id, route, method, profile id,
status code, timestamp, and duration. It never records request bodies, memory
content, or query text. Read it with:

```bash
gmos audit list --db ./gmos.db --key-id key_xxx --since 2026-07-01T00:00:00.000Z
```

Use `gmos http openapi > openapi.json` or `GET /openapi.json` for the OpenAPI
3.1 contract generated from the public route registry and MCP tool schemas.

`GET /evolution/review` returns the same report-only failure review as
`createEvolutionControlPlane().reviewFailures()`. Query parameters are
`profileId`, `failureKind`, and `limit`. It is read-pure apart from the normal
content-free HTTP audit row.

Sensitive override switches, profile deletion, key creation/revocation,
backup/restore, evolution apply/revert, and encryption key management are not
HTTP routes. They remain trusted CLI/SDK operations.

Run `examples/http-adapter.mjs` for a minimal host-style smoke test. The example
starts an ephemeral localhost server with bearer auth, rejects unauthenticated
non-health requests, records an ordinary observation through `/observe`, imports
an explicit preference memory, prepares context through `/prepare`, reads
`/status`, and deletes its temporary plaintext SQLite database.

## Diagnostics Contract

`getGmosRuntimeInfo()`, `gmos version`, `gmos doctor`, `/runtime-info`,
`memory.runtime_info`, and `createMemoryStatusReport()` expose content-free
runtime and integration metadata. They report package, CLI, export, MCP, HTTP,
and local-first trust contract information. The trust contract keeps
`encryptedByDefault: false` and reports `encryptionSupported: "host_driver"`.
`gmos doctor` and `createMemoryStatusReport()` also report whether the inspected
store was opened with a host encryption driver. They do not include memory text,
failure samples, raw profile IDs, or table state hashes.
