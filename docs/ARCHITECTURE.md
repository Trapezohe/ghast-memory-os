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
-> prepareTurn() or reconstructContext()
-> context, evidence, action policy
-> commitOutcome() / recordFeedback()
```

## Sources Of Truth

- `gmos_evidence_events`: evidence ledger for observed host events and derived
  signals.
- `gmos_memories`: active and archived memory records.
- `gmos_world_beliefs`: current and historical world-state beliefs.
- `gmos_task_trajectories`: reusable procedural and task outcome traces.
- `gmos_failure_events`: feedback and failure loop events.
- `gmos_associations`: derived cue/tag/content projection for reconstructive
  retrieval.
- `gmos_memories_fts` and vector tables: derived search indexes.

Associations, FTS rows, and local vector rows are indexes. They can be rebuilt
from source-of-truth rows and must not become independent memory stores.

## Read And Write Boundaries

Write paths:

- `observe()`
- `commitOutcome()`
- `recordFeedback()`
- `forget()`
- low-level admin/import operations
- repair commands that rebuild derived indexes

Read paths:

- `prepareTurn()`
- `reconstructContext()`
- `explainEvidencePath()`
- `search()` when used for context, history, delete, or manage lookup
- `doctor` and `status`

Read paths are checked by gate tests and read-audit snapshots. They should not
write to memory, evidence, failure, association, FTS, or vector tables.

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
