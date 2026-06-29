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

Safe backups exclude archived, sensitive, and person memories by default. Use
`--mode full` only for explicit internal migration rehearsals with appropriate
handling of local files.

## Index Repair

Derived indexes can be rebuilt after import or SQLite drift:

```bash
gmos repair --db ./gmos.db --search-index
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

