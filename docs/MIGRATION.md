# gmOS Migration Guide

This guide is for host applications moving from an existing memory store or
early gmOS alpha integration to the public SDK boundary.

## Migration Principles

- Keep the existing host memory store readable until migration is verified.
- Import through public host helpers or CLI commands, not private SQLite schema
  writes.
- Prefer synthetic QA data for rehearsals; do not publish real user memory.
- Keep gmOS local-first and plaintext unless the host adds its own filesystem
  controls.
- Do not run two independent primary memory systems after cutover.

## Snapshot Import

Hosts with an existing memory store should project records into host memory
snapshots and import them through `@ghast/memory/host`:

```ts
import { loadHostMemorySnapshotsIntoStore } from "@ghast/memory/host";

await loadHostMemorySnapshotsIntoStore({
  store,
  profileId: "local-user",
  snapshots,
});
```

The importer skips person and secret-like snapshots by default before they enter
the gmOS store. Repeated imports are idempotent when the host provides stable
metadata keys.

## Profile Backup And Restore

Use safe profile backups for portable QA and rollback:

```bash
gmos backup --db ./gmos.db --profile local --mode safe --output-file ./backup.json
gmos restore --db ./new-gmos.db --profile local-restored --input-file ./backup.json
```

Safe backups exclude archived, sensitive, and person memories by default. They
include dormant memories because dormant records are still user memory, just
excluded from ordinary context. Use `--mode full` only for explicit trusted
migration rehearsals with appropriate handling of local files.

## Encryption At Rest

Encryption is an open-time store option, not a SQLite schema migration. Schema
version remains v9. A host that wants encryption should open the source or target
store with `createSqliteMemoryStore({ encryption: { driver, key, pragmas } })`
and run normal import, backup, restore, or cutover checks through that opened
store. gmOS does not rewrite an existing plaintext database into an encrypted
file by itself and does not manage key custody.

## SQLite Schema v8

Schema v8 adds first-class lifecycle signals to `gmos_memories`:

- `recall_count INTEGER NOT NULL DEFAULT 0`
- `last_recalled_at TEXT NULL`
- `reinforcement REAL NOT NULL DEFAULT 0`

Existing rows migrate in place with `recall_count = 0`,
`last_recalled_at = NULL`, and `reinforcement = 0`. No row is demoted during
schema migration. Lifecycle transitions happen only when the host explicitly
invokes `maintain()`.

The first maintenance run on an old profile may demote stale active memories to
`dormant` if their retention score is below the configured threshold. Preview it
first:

```bash
gmos maintain --db ./gmos.db --profile local --dry-run --format markdown
```

If the preview is acceptable, run the same command without `--dry-run`.
`boundary` and `person` memories are exempt from automatic transitions by
default. Dormant memories remain available to history recall and can be restored
to active by `commitOutcome({ usedMemoryIds })` when a host reports actual use.

## SQLite Schema v9

Schema v9 makes the memory vector index provider-aware. `gmos_memory_vectors`
adds:

- `provider_name TEXT NOT NULL DEFAULT 'local-hash-v1'`
- `embedding_status TEXT NOT NULL DEFAULT 'embedded'`

Existing local hash vectors migrate in place as `local-hash-v1` with 384
dimensions. When a host configures an embedding provider, health reports normal
eligible memories with old provider names or dimensions as stale provider rows.
Provider failures during writes store fallback local vectors with pending status;
`repairSearchIndex({ vectorBatchSize })` backfills pending/stale rows in bounded
batches.

Sensitive and person memories remain on local fallback vectors unless the host
explicitly opts in through provider config. Secret-like content is never sent to
the provider.

## M3 Experience Learning

M3 does not add a SQLite schema version. Procedure distillation, outcome
reinforcement, feedback confidence penalties, and evolution apply/revert reuse
existing memory, task trajectory, failure, and evidence tables. Already-distilled
clusters and evolution revert state are derived from `gmos_evidence_events`
payloads instead of new columns.

## Index Repair

Derived indexes can be rebuilt after import or SQLite drift:

```bash
gmos repair --db ./gmos.db --search-index --dry-run --vector-batch-size 32
gmos repair --db ./gmos.db --associations
```

Repair rebuilds derived FTS, vector, and association projections from stored
source rows. It must not create new user memory facts.

## Cutover Checklist

1. Run import or restore into a fresh gmOS database.
2. Run `gmos doctor --db ./gmos.db --host ghast --format markdown`.
3. Run `gmos status --db ./gmos.db --profile local --host ghast --format markdown`.
4. Run `npm run gate:pr` in the SDK repo for runtime confidence.
5. Run host-specific E2E for observe, prepare, reconstruct, forget, incognito,
   secret-like content, PERSON isolation, and do-not-push behavior.
6. Switch the host to public SDK, CLI, MCP, HTTP, or host adapter APIs.
7. Remove or explicitly deprecate old primary memory paths.
8. Keep rollback backup artifacts until dogfood has covered ordinary usage.

## Rollback

Rollback should restore the previous host memory path and keep the gmOS database
for diagnosis. Do not merge partially migrated SQLite rows back into a legacy
store without an explicit host-owned migration script.
