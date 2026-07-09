# gmOS Architecture Guide

gmOS is not a top-k vector memory wrapper. It is a local-first Memory OS runtime
kernel for personal agents: it turns host events into evidence-backed memory,
maintains user-world state, reconstructs relevant context, and keeps safety and
forgetting gates enforceable. The long-term product direction is second-brain
and digital-twin infrastructure, while the current package remains a late-alpha
runtime kernel rather than a mature digital twin.

## Data Flow

```text
host event
-> observe()
-> extraction and safety gates
-> evidence event
-> memory / world belief / task trajectory
-> optional turn-retention memory for eligible raw conversation turns
-> optional host session distillation memory for compact dated session facts
-> association projection
-> prepareTurn(), explainTurn(), or reconstructContext()
-> context, evidence, action policy
-> commitOutcome() / recordFeedback()
-> explicit maintain()
-> decay / duplicate consolidation / host semantic consolidation / host procedure distillation
-> active / dormant / archived lifecycle, consolidation, distillation evidence, and gap projection
-> curiosity action policies from the precomputed gap index
-> optional host-scheduled autopilot composition of ingest / repair / maintain
-> approval-gated evolution apply/revert when an admin accepts a proposal
-> forensic rollback when an approved operator restores a memory from evidence
```

## Sources Of Truth

- `gmos_evidence_events`: evidence ledger for observed host events and derived
  signals.
- `gmos_memories`: active, dormant, and archived memory records, including
  recall counters and reinforcement signals.
- `gmos_world_beliefs`: current and historical world-state beliefs.
- `gmos_task_trajectories`: reusable procedural and task outcome traces.
- `gmos_failure_events`: feedback and failure loop events.
- `gmos_associations`: derived cue/tag/content projection for reconstructive
  retrieval.
- `gmos_gap_candidates`: derived proactive-exploration projection for bounded
  curiosity prompts.
- `gmos_memories_fts` and provider-aware vector tables: derived search
  indexes. Vector rows record provider name, dimensions, embedding status, and
  content hash.
- `gmos_autopilot_runs`: content-free run history for host-scheduled autopilot
  executions.

Associations, gap candidates, FTS rows, and vector rows are indexes. They can be rebuilt from
source-of-truth rows and must not become independent memory stores. The
`local-hash-v1` 384-dimensional vector is the deterministic fallback; host
embedding providers are optional write/repair-path upgrades.

Windowed conversation ingest is layered. With `turnRetention`, eligible raw
turns are stored as low-confidence ordinary memories with
`metadata.turnMemory = true` and default confidence `0.35`. Extracted atoms
remain the structured semantic layer: higher-confidence memories and world
beliefs supplied by the host extractor. With `sessionDistillation`, a host hook
can add compact dated session-summary memories with default confidence `0.6`.
All three layers point back to evidence events and use existing memory kinds.
Raw turns preserve episodic wording, atoms carry durable structure, and session
summaries give aggregation questions a small set of per-session enumerations.
This does not add schema or a new memory kind.

## Read And Write Boundaries

Embedding providers are write-path hooks. gmOS may call them while adding or
updating memory, while writing host consolidation summaries or distilled
procedures, and during explicit search-index repair/backfill. Ordinary
`prepareTurn`, `reconstructContext`, `explainTurn`, `explainEvidencePath`, and
`search` do not call the provider. Host-opted query embedding is the sole
read-time provider call and requires an explicit `retrieval.embedQuery` option
with timeout and the same secret-like sensitivity gate as stored content.
Memory-content embeddings created inside one ingest/import operation are
batched before persistence. gmOS keeps the same privacy gates and row order,
uses the provider's declared `maxBatchSize` or `32`, and applies the existing
timeout to each provider call. A failed provider batch counts as one embedding
failure for ingest stats; only that batch's rows fall back to the local hash
lane with pending repair status.

Write paths:

- `observe()`
- `commitOutcome()`
- `recordFeedback()`
- `maintain()`
- `forget()`
- `memoryRollback()` / `gmos rollback`
- `applyEvolutionProposal()` / `revertEvolutionApplication()` through SDK/CLI admin surfaces
- low-level admin/import operations
- repair commands that rebuild derived indexes
- `runAutopilot()` / `gmos autopilot run`, which only composes transcript
  ingestion, explicit search-index repair/backfill, and `maintain()`

Read paths:

- `prepareTurn()`
- `explainTurn()`
- `reconstructContext()`
- `explainEvidencePath()`
- `search()` when used for context, history, delete, or manage lookup
- `doctor` and `status`

Read paths are checked by gate tests and read-audit snapshots. They should not
write to memory, evidence, failure, association, gap candidate, FTS, or vector
tables.

## Lifecycle Model

Forgetting is a reversible lifecycle, not only explicit deletion. `active`
memories can become `dormant` through explicit `maintain()` when deterministic
retention scoring falls below the configured threshold. Dormant memories are
excluded from ordinary context and active association projection like archived
memories, but remain visible to history-purpose recall and status-filtered
management surfaces. Long-dormant memories can later become `archived`.

Turn-retention memories participate in the same lifecycle math as any other
memory. Hosts should treat them as fast-decaying episodic support: consolidation
can summarize clusters into durable semantic atoms, then maintenance naturally
demotes the lower-confidence raw turns. This is the episodic-to-semantic path;
it avoids keeping every raw turn active forever.

`commitOutcome({ usedMemoryIds })` is the usage-signal write path. It increments
recall counters, sets `last_recalled_at`, reactivates dormant memories, and
applies bounded outcome reinforcement in the same transaction as the outcome
write. `recordFeedback({ relatedMemoryIds, signal })` updates bounded
reinforcement in the same transaction as feedback; `wrong_recall` feedback can
also lower confidence to affect ranking. Reinforcement affects retention.

Derived memories carry their provenance in existing evidence and metadata. When
an outcome credits a consolidation summary, distilled procedure, or dossier,
gmOS propagates bounded non-independent credit through that provenance DAG.
Memory-typed sources receive decayed reinforcement; task trajectories and world
beliefs are only recorded as credited provenance in the outcome payload. The
walk is deterministic and bounded by depth and fan-out, and hard stops apply at
forgotten/archived-by-forget sources, redacted evidence stubs, and person
memories.

Every maintenance transition writes a content-free evidence event with
`source_type = "maintenance"` and `eligible_for_long_term_memory = 0`. Dry-run
maintenance computes the same report but writes nothing and is covered by the
read-audit snapshot mechanism. No read path runs lifecycle maintenance in the
background.

Consolidation is a write-path capability, not a read-time side effect. The
standalone duplicate path remains an explicit `maintain()` phase. Active and
dormant memories are clustered per profile/kind by normalized content equality
or containment plus association tag overlap, while `boundary`, `person`,
archived, sensitive, and secret-like memories are excluded. The canonical
survivor is selected by confidence, newest `updated_at`, then id, and its
content is never rewritten. Archived duplicate members carry
`metadata.supersededBy` and a `source_type = "consolidation"` evidence event.

Semantic consolidation uses the second host hook, `consolidator`, mirroring the
structured extractor boundary. gmOS selects bounded clusters and enforces write
gates, but only the host hook can synthesize summary prose. Accepted summaries
are new memories whose consolidation evidence lists source memory ids; source
episodes are demoted to dormant with lifecycle evidence.

Entity consolidation is an opt-in selector available both in the `consolidate`
maintain phase and directly inside `ingestConversation({ consolidateEntities })`.
It addresses extracted-fact fragmentation by grouping different predicates about
the same entity before the host consolidator runs. Ingest-integrated entity
consolidation runs after window extraction, turn retention, and session
distillation, but its scope is only the newly written extracted `fact` memories
from that ingest call; raw turn memories and session summaries are not entity
cluster inputs. The selector is read-pure and LLM-free: it computes document
frequency over candidate tokens in memory content across the passed memories,
then groups each eligible memory by its rarest distinctive token. Candidate
tokens are model/product codes, scale codes, and proper-noun-like words;
stopwords and tokens above the fixed high-frequency cutoff are ignored. The host
consolidator receives `kind: "entity"` plus the source `memoryKind`, `entityKey`,
and `entityObject`; accepted summaries use the same consolidation evidence and
dormant-source provenance as other host summaries. Hosts that want mem0-style
canonical facts during normal ingest should enable `consolidateEntities`.

Procedure distillation is a separate explicit `maintain({ phases: ["distill"] })`
phase. gmOS deterministically clusters repeated completed task trajectories by
normalized objective and stable token set, but only the host `procedureDistiller`
hook can synthesize procedure prose. Accepted candidates become active
`procedure` memories with `source_type = "distillation"` evidence listing source
trajectory ids. Source trajectories are not archived or modified.

Proactive exploration is a separate explicit `maintain({ phases: ["explore"] })`
phase. It runs deterministic analyzers over source state and rebuilds
`gmos_gap_candidates` for stale load-bearing beliefs, contradiction hotspots,
coverage gaps, and decaying procedures. Generation gates suppress boundary,
forgotten/redacted, sensitive, and person material before persistence.
`prepareTurn()` only reads this precomputed index, applies the same current
privacy gates again, and emits low-priority `curiosity` action policies with
deterministic template text. It never computes or writes gaps on a read path.

Evolution is propose-with-approval. `reviewFailures()` remains a read path and
clusters failure events into hypotheses, memory-target patch proposals, and
recommendation-only parameter proposals without writes. `applyEvolutionProposal()`
is an SDK/CLI admin write path that requires `approvedBy`, applies only bounded
reinforcement/confidence/status actions, and writes `source_type = "evolution"`
evidence with previous values. Parameter proposals are host-owned config
recommendations and are rejected by apply with a typed error. Revert restores
those previous values and writes its own evolution evidence. Nothing in
`maintain()` runs evolution.

Forensic rollback is also a write path. Every memory-mutating path records
`previousValues` sufficient to reconstruct prior state. `memoryRollback()` and
`gmos rollback` replay a memory's evidence chain to a target evidence event,
restore that snapshot, and write `source_type = "memory.rollback"` evidence
with its own `previousValues`. If the chain crosses pre-M13 evidence without
state snapshots, rollback fails closed instead of guessing.

Autopilot is the same explicit-write contract on a schedule. The host chooses
the one-shot CLI, cron/launchd, or the local `gmos serve` timer. Each action
inside a run is an ordinary evidence-backed write path or dry-run preview:
transcript ingestion calls `observe()`, embedding backfill calls the existing
repair machinery, and maintenance calls `maintain()`. The run history report is
content-free. No HTTP route starts autopilot, and autopilot never calls
evolution apply/revert.

## Reconstruction Model

gmOS uses bounded active reconstruction instead of one-shot top-k recall:

```text
query cues
-> association tags
-> content/evidence
-> new cues from intermediate evidence
-> convergence or budget stop
```

The planner remains bounded by step, branch, and token budgets. Context output
should carry uncertainty, conflict, current/history, and evidence markers rather
than blindly stuffing every neighbor into the prompt.
Memory and reconstruction content lines also carry compact temporal labels from
existing metadata, so reader models can reason about dates without schema
changes or extra retrieval passes.

For aggregation queries, hosts can declare `reconstructionIntent.sweepCues`.
Those cues do not seed or rerank ordinary retrieval. After the ordinary memory
and path sections are complete, gmOS runs bounded per-cue searches through the
same store gates and appends an `Additional dated mentions:` section. Sweep
lines are deduped against ordinary memories, sorted chronologically, and culled
inside a sweep-only budget extension so ordinary reconstruction never shrinks
because a sweep exists.

Within those fixed budgets, reconstruction uses anchor-diversified allocation.
Initial anchors come from the same lexical/host cue extraction and structured
query cues that already seed the frontier. The planner groups frontier
candidates by originating anchor, gives each anchor its quota of attempts in
round-robin order, then spends any remainder by global route score. If memory
budget remains, uncovered anchors get a bounded direct-memory top-up before the
ordinary hybrid path runs. Diagnostics report candidate and included counts per
anchor plus `uncoveredAnchors`.

Layered supply is a post-ranking allocation, not a second retrieval system. If a
host passes `layerPolicy`, reconstruction first builds the same visible ranked
candidate pool, using provenance metadata only to classify summaries
(`sessionDistillation`), raw turns (`turnMemory`), and atoms (everything else).
It then applies the summary minimum and turn maximum to the final slots, releases
unused reservations back to rank order, and filters paths/anchor diagnostics to
the post-policy inclusion. Without `layerPolicy`, this pass is absent and the
legacy global pool remains byte-identical.

Hosts may also declare `reconstructionIntent.requiredAnchors`. These are not
inferred by the kernel and are not dataset rules; they are host-owned endpoint
descriptions. Required anchors reserve memory slots ahead of ordinary anchors and
each receives one direct store search using the anchor text. If query embedding
is active, that required-anchor pass gets its own anchor-text embedding under the
same secret-like and failure fallback gates. Unmet required anchors stay visible
as `requiredAnchorUnmet` in reconstruction stats and anchor coverage.

Direct memory retrieval uses one shared hybrid search path. FTS rank, vector
cosine similarity, and association/tag overlap are fused with fixed default
weights (`fts=1`, `vector=1.2`, `association=0.8`) and deterministic tie-breaks
by score, recency, then id. Safety, lifecycle, supersession, temporal, person,
and sensitivity gates run after fusion, so semantic similarity cannot resurface
content that ordinary recall would hide.

`explainTurn()` is a read-only explanation mode on the same turn pipeline, not a
second retrieval implementation. The runtime threads an optional trace collector
through `searchMemories()` and `prepareTurnCore()`: ordinary `prepareTurn()`
does not allocate trace state, while explanation mode records included and
excluded memory decisions, score components, safety/lifecycle reasons, and
budget stops before returning a report without `contextBlock`.

## Safety Model

Safety gates are part of the runtime contract:

- secret-like content is not persisted as ordinary long-term memory;
- incognito/private events are not promoted;
- public MCP and HTTP surfaces do not expose sensitive override switches;
- PERSON/person memory is isolated from ordinary user memory;
- forget archives matching memory, removes derived context residue, and redacts
  source evidence content when all derived memories from that event are
  forgotten;
- do-not-push boundaries become action policy, not optional prose.

Write provenance is trust-tiered. Host events can declare
`sourceTrust: "user" | "agent" | "external"`; defaults are user trust for
user-role events, agent trust for assistant/tool/summary/note events, and
external trust for foreign imports. Agent/external evidence can create ordinary
memories only with capped confidence and annealing metadata. It cannot create
boundary/procedure policy memories or supersede a higher-trust
single-cardinality world belief unless the host explicitly records an override.

Confidence annealing is derived from evidence history and metadata. Rapid
reinforcement from non-independent evidence, or a lower-trust source, caps the
memory's effective ranking and retention contribution until independent
confirmation. Propagated provenance credit is explicitly non-independent and
does not lift annealing caps. `explainTurn()` and lifecycle history expose active
annealing so hosts can see why a memory was downweighted.

Hosts can provide an additive sensitivity classifier for product-specific local
terms. The built-in detector remains active and gmOS uses the maximum
sensitivity, so host policy can tighten storage/context gates without weakening
default secret-like protections or growing core language keyword lists.

These gates must not be weakened to improve benchmark scores.

## Host Boundary

Host applications own the UI, filesystem permissions, model calls, and action
execution. gmOS owns memory policy, local persistence, reconstruction,
diagnostics, and integration contracts. A host should integrate through public
SDK, CLI, MCP, HTTP, or host adapter APIs and should not copy internal runtime
logic.
