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
-> association projection
-> prepareTurn(), explainTurn(), or reconstructContext()
-> context, evidence, action policy
-> commitOutcome() / recordFeedback()
-> explicit maintain()
-> decay / duplicate consolidation / host semantic consolidation / host procedure distillation
-> active / dormant / archived lifecycle, consolidation, and distillation evidence
-> approval-gated evolution apply/revert when an admin accepts a proposal
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
- `gmos_memories_fts` and provider-aware vector tables: derived search
  indexes. Vector rows record provider name, dimensions, embedding status, and
  content hash.

Associations, FTS rows, and vector rows are indexes. They can be rebuilt from
source-of-truth rows and must not become independent memory stores. The
`local-hash-v1` 384-dimensional vector is the deterministic fallback; host
embedding providers are optional write/repair-path upgrades.

## Read And Write Boundaries

Embedding providers are write-path hooks. gmOS may call them while adding or
updating memory, while writing host consolidation summaries or distilled
procedures, and during explicit search-index repair/backfill. Ordinary
`prepareTurn`, `reconstructContext`, `explainTurn`, `explainEvidencePath`, and
`search` do not call the provider. Query embedding is the only read-time
exception and requires an explicit `retrieval.embedQuery` option with timeout
and the same secret-like sensitivity gate as stored content.

Write paths:

- `observe()`
- `commitOutcome()`
- `recordFeedback()`
- `maintain()`
- `forget()`
- `applyEvolutionProposal()` / `revertEvolutionApplication()` through SDK/CLI admin surfaces
- low-level admin/import operations
- repair commands that rebuild derived indexes

Read paths:

- `prepareTurn()`
- `explainTurn()`
- `reconstructContext()`
- `explainEvidencePath()`
- `search()` when used for context, history, delete, or manage lookup
- `doctor` and `status`

Read paths are checked by gate tests and read-audit snapshots. They should not
write to memory, evidence, failure, association, FTS, or vector tables.

## Lifecycle Model

Forgetting is a reversible lifecycle, not only explicit deletion. `active`
memories can become `dormant` through explicit `maintain()` when deterministic
retention scoring falls below the configured threshold. Dormant memories are
excluded from ordinary context and active association projection like archived
memories, but remain visible to history-purpose recall and status-filtered
management surfaces. Long-dormant memories can later become `archived`.

`commitOutcome({ usedMemoryIds })` is the usage-signal write path. It increments
recall counters, sets `last_recalled_at`, reactivates dormant memories, and
applies bounded outcome reinforcement in the same transaction as the outcome
write. `recordFeedback({ relatedMemoryIds, signal })` updates bounded
reinforcement in the same transaction as feedback; `wrong_recall` feedback can
also lower confidence to affect ranking. Reinforcement affects retention.

Every maintenance transition writes a content-free evidence event with
`source_type = "maintenance"` and `eligible_for_long_term_memory = 0`. Dry-run
maintenance computes the same report but writes nothing and is covered by the
read-audit snapshot mechanism. No read path runs lifecycle maintenance in the
background.

Consolidation is an explicit `maintain()` phase, not a read-time side effect.
The kernel-side duplicate path is deterministic: active and dormant memories are
clustered per profile/kind by normalized content equality or containment plus
association tag overlap, while `boundary`, `person`, archived, sensitive, and
secret-like memories are excluded. The canonical survivor is selected by
confidence, newest `updated_at`, then id, and its content is never rewritten.
Archived duplicate members carry `metadata.supersededBy` and a
`source_type = "consolidation"` evidence event.

Semantic consolidation uses the second host hook, `consolidator`, mirroring the
structured extractor boundary. gmOS selects bounded clusters and enforces write
gates, but only the host hook can synthesize summary prose. Accepted summaries
are new memories whose consolidation evidence lists source memory ids; source
episodes are demoted to dormant with lifecycle evidence.

Procedure distillation is a separate explicit `maintain({ phases: ["distill"] })`
phase. gmOS deterministically clusters repeated completed task trajectories by
normalized objective and stable token set, but only the host `procedureDistiller`
hook can synthesize procedure prose. Accepted candidates become active
`procedure` memories with `source_type = "distillation"` evidence listing source
trajectory ids. Source trajectories are not archived or modified.

Evolution is propose-with-approval. `reviewFailures()` remains a read path and
clusters failure events into hypotheses and patch proposals without writes.
`applyEvolutionProposal()` is an SDK/CLI admin write path that requires
`approvedBy`, applies only bounded reinforcement/confidence/status actions, and
writes `source_type = "evolution"` evidence with previous values. Revert restores
those previous values and writes its own evolution evidence. Nothing in
`maintain()` runs evolution.

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
- forget archives matching memory and removes derived context residue;
- do-not-push boundaries become action policy, not optional prose.

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
