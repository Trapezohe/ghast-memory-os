import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import type {
  ActionPolicy,
  AddMemoryInput,
  AddWorldBeliefInput,
  ArchiveMemoriesInput,
  ArchiveMemoryInput,
  ArchiveStaleHostImportsInput,
  EvidenceEvent,
  FailureEventRecord,
  ForgetInput,
  ForgetResult,
  ListFailuresInput,
  MemoryListInput,
  MemoryKind,
  MemoryRecord,
  MemorySearchInput,
  MemoryStore,
  RecordEvidenceInput,
  RecordFailureInput,
  RepairSearchIndexResult,
  RestoreArchivedMemoryInput,
  SearchIndexStatus,
  Sensitivity,
  TaskTrajectoryInput,
  UpdateMemoryInput,
  WorldBeliefRecord,
} from "../../kernel/types.js";
import { shouldHideFromOrdinaryContext } from "../../kernel/safety.js";
import { ensureSqliteSchema, sqliteSchemaVersion } from "./schema.js";

export interface SqliteMemoryStoreOptions {
  path: string;
  handle?: Database.Database;
  readonly?: boolean | undefined;
  fileMustExist?: boolean | undefined;
}

export interface SqliteMemoryStore extends MemoryStore {
  listFailures(input: ListFailuresInput): FailureEventRecord[];
  schemaVersion(): number;
  searchIndexStatus(): SearchIndexStatus;
  repairSearchIndex(): RepairSearchIndexResult;
}

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function metadataWithArchiveMarker(input: {
  metadata: Record<string, unknown>;
  archivedAt: string;
  reason?: string | undefined;
}): Record<string, unknown> {
  return {
    ...input.metadata,
    archive: {
      ...(typeof input.metadata.archive === "object" &&
      input.metadata.archive !== null &&
      !Array.isArray(input.metadata.archive)
        ? input.metadata.archive
        : {}),
      archivedAt: input.archivedAt,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  };
}

function metadataWithRestoreMarker(input: {
  metadata: Record<string, unknown>;
  restoredAt: string;
  reason?: string | undefined;
}): Record<string, unknown> {
  const { archive: _archive, ...metadata } = input.metadata;
  return {
    ...metadata,
    restore: {
      ...(typeof metadata.restore === "object" &&
      metadata.restore !== null &&
      !Array.isArray(metadata.restore)
        ? metadata.restore
        : {}),
      restoredAt: input.restoredAt,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  };
}

function normalizeMemory(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    kind: String(row.kind) as MemoryKind,
    scope: String(row.scope),
    content: String(row.content),
    sensitivity: String(row.sensitivity) as Sensitivity,
    status: String(row.status) as MemoryRecord["status"],
    confidence: Number(row.confidence),
    sourceEventId: row.source_event_id == null ? null : String(row.source_event_id),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeEvidence(row: Record<string, unknown>): EvidenceEvent {
  return {
    id: String(row.id),
    eventKey: String(row.event_key),
    profileId: String(row.profile_id),
    sourceType: String(row.source_type),
    sourceUri: row.source_uri == null ? null : String(row.source_uri),
    content: String(row.content),
    sensitivity: String(row.sensitivity) as Sensitivity,
    eligibleForLongTermMemory: Number(row.eligible_for_long_term_memory) === 1,
    payload: parseJsonObject(row.payload_json),
    createdAt: String(row.created_at),
  };
}

function normalizeFailure(row: Record<string, unknown>): FailureEventRecord {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    failureKind: String(row.failure_kind) as FailureEventRecord["failureKind"],
    content: String(row.content),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: String(row.created_at),
  };
}

function scoreMemory(memory: MemoryRecord, query: string): number {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(Boolean);
  if (terms.length === 0) return memory.confidence;
  const lower = memory.content.toLowerCase();
  const hits = terms.filter((term) => lower.includes(term)).length;
  return hits + memory.confidence;
}

function limit(input: number | undefined, fallback: number, maximum: number): number {
  if (input === undefined) return fallback;
  return Math.max(1, Math.min(Math.trunc(input), maximum));
}

function visibleMemory(input: {
  memory: MemoryRecord;
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
}): boolean {
  if (!input.includePerson && input.memory.kind === "person") return false;
  return !shouldHideFromOrdinaryContext({
    sensitivity: input.memory.sensitivity,
    includeSensitive: input.includeSensitive,
  });
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 16);
}

function ftsQuery(query: string): string | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function likePattern(term: string): string {
  return `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export function createSqliteMemoryStore(options: SqliteMemoryStoreOptions): SqliteMemoryStore {
  const sqliteOptions: Database.Options = {};
  if (options.readonly !== undefined) sqliteOptions.readonly = options.readonly;
  if (options.fileMustExist !== undefined) sqliteOptions.fileMustExist = options.fileMustExist;
  const db =
    options.handle ??
    new Database(options.path, sqliteOptions);
  let initialized = false;
  let ftsAvailableCache: boolean | null = null;

  function initialize(): void {
    if (initialized) return;
    if (db.readonly) {
      ftsAvailableCache = tableExists("gmos_memories_fts");
      initialized = true;
      return;
    }
    ensureSqliteSchema(db);
    ftsAvailableCache = tableExists("gmos_memories_fts");
    initialized = true;
  }

  function tableExists(table: string): boolean {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name?: string } | undefined;
    return row?.name === table;
  }

  function ftsAvailable(): boolean {
    return ftsAvailableCache ?? tableExists("gmos_memories_fts");
  }

  function syncMemoryFts(memoryId: string): void {
    if (!ftsAvailable()) return;
    db.prepare("DELETE FROM gmos_memories_fts WHERE id = ?").run(memoryId);
    const row = db
      .prepare(
        `SELECT id, profile_id, kind, scope, status, content
         FROM gmos_memories
         WHERE id = ?`,
      )
      .get(memoryId) as
      | {
          id: string;
          profile_id: string;
          kind: string;
          scope: string;
          status: string;
          content: string;
        }
      | undefined;
    if (!row) return;
    db.prepare(
      `INSERT INTO gmos_memories_fts(id, profile_id, kind, scope, status, content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.profile_id, row.kind, row.scope, row.status, row.content);
  }

  function searchIndexStatus(): SearchIndexStatus {
    initialize();
    const totalMemoryCount = tableExists("gmos_memories")
      ? Number(
          (
            db
              .prepare("SELECT COUNT(*) AS count FROM gmos_memories")
              .get() as { count: number }
          ).count,
        )
      : 0;
    const activeMemoryCount = tableExists("gmos_memories")
      ? Number(
          (
            db
              .prepare("SELECT COUNT(*) AS count FROM gmos_memories WHERE status = 'active'")
              .get() as { count: number }
          ).count,
        )
      : 0;
    const hasFts = tableExists("gmos_memories_fts");
    ftsAvailableCache = hasFts;
    if (!hasFts) {
      return {
        status: "missing",
        totalMemoryCount,
        indexedMemoryCount: 0,
        activeMemoryCount,
        missingEntryCount: totalMemoryCount,
        staleEntryCount: 0,
        orphanEntryCount: 0,
        duplicateEntryCount: 0,
      };
    }
    const indexedMemoryCount = Number(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM gmos_memories_fts")
          .get() as { count: number }
      ).count,
    );
    const missingEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM gmos_memories m
             WHERE NOT EXISTS (
               SELECT 1 FROM gmos_memories_fts f WHERE f.id = m.id
             )`,
          )
          .get() as { count: number }
      ).count,
    );
    const orphanEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM gmos_memories_fts f
             WHERE NOT EXISTS (
               SELECT 1 FROM gmos_memories m WHERE m.id = f.id
             )`,
          )
          .get() as { count: number }
      ).count,
    );
    const staleEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM gmos_memories_fts f
             JOIN gmos_memories m ON m.id = f.id
             WHERE f.profile_id IS NOT m.profile_id
                OR f.kind IS NOT m.kind
                OR f.scope IS NOT m.scope
                OR f.status IS NOT m.status
                OR f.content IS NOT m.content`,
          )
          .get() as { count: number }
      ).count,
    );
    const duplicateEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(entry_count - 1), 0) AS count
             FROM (
               SELECT id, COUNT(*) AS entry_count
               FROM gmos_memories_fts
               GROUP BY id
               HAVING COUNT(*) > 1
             )`,
          )
          .get() as { count: number | null }
      ).count ?? 0,
    );
    const status =
      missingEntryCount === 0 &&
      staleEntryCount === 0 &&
      orphanEntryCount === 0 &&
      duplicateEntryCount === 0
        ? "ok"
        : "stale";
    return {
      status,
      totalMemoryCount,
      indexedMemoryCount,
      activeMemoryCount,
      missingEntryCount,
      staleEntryCount,
      orphanEntryCount,
      duplicateEntryCount,
    };
  }

  function repairSearchIndex(): RepairSearchIndexResult {
    initialize();
    const before = searchIndexStatus();
    if (db.readonly) throw new Error("gmOS SQLite store is readonly");
    if (!ftsAvailable()) throw new Error("gmOS SQLite search index is missing");
    const repairedAt = nowIso();
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM gmos_memories_fts").run();
      db.prepare(
        `INSERT INTO gmos_memories_fts(id, profile_id, kind, scope, status, content)
         SELECT id, profile_id, kind, scope, status, content
         FROM gmos_memories`,
      ).run();
    });
    tx();
    const after = searchIndexStatus();
    return {
      repaired: before.status !== "ok" && after.status === "ok",
      before,
      after,
      repairedAt,
    };
  }

  function memoryRowsForSearch(input: MemorySearchInput): Record<string, unknown>[] {
    const query = input.query?.trim() ?? "";
    const candidateLimit = Math.max(input.limit ?? 12, 100);
    if (!query) {
      return db
        .prepare(
          `SELECT * FROM gmos_memories
           WHERE profile_id = ? AND status = 'active'
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(input.profileId, Math.max(candidateLimit, 500)) as Record<string, unknown>[];
    }

    const match = ftsQuery(query);
    if (match && ftsAvailable()) {
      try {
        const rows = db
          .prepare(
            `SELECT m.*
             FROM gmos_memories_fts
             JOIN gmos_memories m ON m.id = gmos_memories_fts.id
             WHERE gmos_memories_fts MATCH ?
               AND m.profile_id = ?
               AND m.status = 'active'
             ORDER BY bm25(gmos_memories_fts), m.updated_at DESC
             LIMIT ?`,
          )
          .all(match, input.profileId, Math.max(candidateLimit, 500)) as Record<string, unknown>[];
        if (rows.length > 0) return rows;
      } catch {
        // Fall back to LIKE search for tokenizer or parser edge cases.
      }
    }

    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const clauses = terms.map(() => "content LIKE ? ESCAPE '\\'");
    return db
      .prepare(
        `SELECT * FROM gmos_memories
         WHERE profile_id = ?
           AND status = 'active'
           AND (${clauses.join(" OR ")})
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(
        input.profileId,
        ...terms.map(likePattern),
        Math.max(candidateLimit, 500),
      ) as Record<string, unknown>[];
  }

  function memoryRowsForList(input: MemoryListInput): Record<string, unknown>[] {
    const clauses = ["profile_id = ?"];
    const params: unknown[] = [input.profileId];
    if (input.status && input.status !== "any") {
      clauses.push("status = ?");
      params.push(input.status);
    } else if (!input.status) {
      clauses.push("status = 'active'");
    }
    if (input.kind) {
      clauses.push("kind = ?");
      params.push(input.kind);
    }
    if (input.scope) {
      clauses.push("scope = ?");
      params.push(input.scope);
    }
    const query = input.query?.trim() ?? "";
    if (!query) {
      return db
        .prepare(
          `SELECT * FROM gmos_memories
           WHERE ${clauses.join(" AND ")}
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(...params, limit(input.limit, 100, 500)) as Record<string, unknown>[];
    }

    const match = ftsQuery(query);
    if (match && ftsAvailable()) {
      try {
        const rows = db
          .prepare(
            `SELECT m.*
             FROM gmos_memories_fts
             JOIN gmos_memories m ON m.id = gmos_memories_fts.id
             WHERE gmos_memories_fts MATCH ?
               AND ${clauses.map((clause) => `m.${clause}`).join(" AND ")}
             ORDER BY bm25(gmos_memories_fts), m.updated_at DESC
             LIMIT ?`,
          )
          .all(match, ...params, Math.max(limit(input.limit, 100, 500), 500)) as Record<
          string,
          unknown
        >[];
        if (rows.length > 0) return rows;
      } catch {
        // Fall back to LIKE search for tokenizer or parser edge cases.
      }
    }

    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const likeClauses = terms.map(() => "content LIKE ? ESCAPE '\\'");
    return db
      .prepare(
        `SELECT * FROM gmos_memories
         WHERE ${clauses.join(" AND ")}
           AND (${likeClauses.join(" OR ")})
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(
        ...params,
        ...terms.map(likePattern),
        Math.max(limit(input.limit, 100, 500), 500),
      ) as Record<string, unknown>[];
  }

  function recordEvidence(input: RecordEvidenceInput): EvidenceEvent {
    initialize();
    const createdAt = input.createdAt ?? nowIso();
    const eventId = id("evidence");
    db.prepare(
      `INSERT INTO gmos_evidence_events (
        id, event_key, profile_id, source_type, source_uri, content, sensitivity,
        eligible_for_long_term_memory, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        content = excluded.content,
        sensitivity = excluded.sensitivity,
        eligible_for_long_term_memory = excluded.eligible_for_long_term_memory,
        payload_json = excluded.payload_json`,
    ).run(
      eventId,
      input.eventKey,
      input.profileId,
      input.sourceType,
      input.sourceUri ?? null,
      input.content,
      input.sensitivity,
      input.eligibleForLongTermMemory ? 1 : 0,
      JSON.stringify(input.payload ?? {}),
      createdAt,
    );
    const row = db
      .prepare("SELECT * FROM gmos_evidence_events WHERE event_key = ?")
      .get(input.eventKey) as Record<string, unknown>;
    return normalizeEvidence(row);
  }

  function addMemory(input: AddMemoryInput): MemoryRecord {
    initialize();
    const createdAt = input.createdAt ?? nowIso();
    const memoryId = id("memory");
    db.prepare(
      `INSERT INTO gmos_memories (
        id, profile_id, kind, scope, content, sensitivity, status, confidence,
        source_event_id, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    ).run(
      memoryId,
      input.profileId,
      input.kind,
      input.scope ?? "global",
      input.content,
      input.sensitivity ?? "normal",
      input.confidence ?? 0.5,
      input.sourceEventId ?? null,
      JSON.stringify(input.metadata ?? {}),
      createdAt,
      createdAt,
    );
    syncMemoryFts(memoryId);
    return normalizeMemory(
      db
        .prepare("SELECT * FROM gmos_memories WHERE id = ?")
        .get(memoryId) as Record<string, unknown>,
    );
  }

  function updateMemory(input: UpdateMemoryInput): MemoryRecord | null {
    initialize();
    const existing = db
      .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ? AND status = 'active'")
      .get(input.profileId, input.id) as Record<string, unknown> | undefined;
    if (!existing) return null;
    const previous = normalizeMemory(existing);
    const updatedAt = input.updatedAt ?? nowIso();
    const next = {
      kind: input.kind ?? previous.kind,
      scope: input.scope ?? previous.scope,
      content: input.content ?? previous.content,
      sensitivity: input.sensitivity ?? previous.sensitivity,
      confidence: input.confidence ?? previous.confidence,
      sourceEventId:
        input.sourceEventId === undefined ? previous.sourceEventId : input.sourceEventId,
      metadata: input.metadata ?? previous.metadata,
    };
    db.prepare(
      `UPDATE gmos_memories
       SET kind = ?,
           scope = ?,
           content = ?,
           sensitivity = ?,
           confidence = ?,
           source_event_id = ?,
           metadata_json = ?,
           updated_at = ?
       WHERE profile_id = ? AND id = ? AND status = 'active'`,
    ).run(
      next.kind,
      next.scope,
      next.content,
      next.sensitivity,
      next.confidence,
      next.sourceEventId ?? null,
      JSON.stringify(next.metadata),
      updatedAt,
      input.profileId,
      input.id,
    );
    syncMemoryFts(input.id);
    return normalizeMemory(
      db
        .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ?")
        .get(input.profileId, input.id) as Record<string, unknown>,
    );
  }

  function archiveMemoryById(input: ArchiveMemoryInput): boolean {
    initialize();
    const archivedAt = input.archivedAt ?? nowIso();
    const existing = db
      .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ? AND status = 'active'")
      .get(input.profileId, input.id) as Record<string, unknown> | undefined;
    if (!existing) return false;
    const metadata = metadataWithArchiveMarker({
      metadata: parseJsonObject(existing.metadata_json),
      archivedAt,
      reason: input.reason,
    });
    const result = db
      .prepare(
        `UPDATE gmos_memories
         SET status = 'archived', updated_at = ?, metadata_json = ?
         WHERE profile_id = ? AND id = ? AND status = 'active'`,
      )
      .run(archivedAt, JSON.stringify(metadata), input.profileId, input.id);
    syncMemoryFts(input.id);
    return result.changes > 0;
  }

  function restoreArchivedMemory(input: RestoreArchivedMemoryInput): boolean {
    initialize();
    const restoredAt = input.restoredAt ?? nowIso();
    const existing = db
      .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ? AND status = 'archived'")
      .get(input.profileId, input.id) as Record<string, unknown> | undefined;
    if (!existing) return false;
    const metadata = metadataWithRestoreMarker({
      metadata: parseJsonObject(existing.metadata_json),
      restoredAt,
      reason: input.reason,
    });
    const result = db
      .prepare(
        `UPDATE gmos_memories
         SET status = 'active', updated_at = ?, metadata_json = ?
         WHERE profile_id = ? AND id = ? AND status = 'archived'`,
      )
      .run(restoredAt, JSON.stringify(metadata), input.profileId, input.id);
    syncMemoryFts(input.id);
    return result.changes > 0;
  }

  function archiveMemories(input: ArchiveMemoriesInput): string[] {
    initialize();
    if (!input.all && !input.scope && !input.metadataEquals) {
      throw new Error("archiveMemories requires all, scope, or metadataEquals");
    }
    const clauses = ["profile_id = ?", "status = 'active'"];
    const params: unknown[] = [input.profileId];
    if (!input.all && input.scope) {
      clauses.push("scope = ?");
      params.push(input.scope);
    }
    if (!input.all && input.metadataEquals) {
      clauses.push("json_extract(metadata_json, ?) = ?");
      params.push(`$.${input.metadataEquals.key}`, input.metadataEquals.value);
    }
    const where = clauses.join(" AND ");
    const rows = db
      .prepare(`SELECT id, metadata_json FROM gmos_memories WHERE ${where}`)
      .all(...params) as Array<{ id: string; metadata_json: string }>;
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return [];
    const stmt = db.prepare(
      `UPDATE gmos_memories
       SET status = 'archived', updated_at = ?, metadata_json = ?
       WHERE profile_id = ? AND id = ?`,
    );
    const archivedAt = input.archivedAt ?? nowIso();
    const tx = db.transaction((memoryRows: Array<{ id: string; metadata_json: string }>) => {
      for (const row of memoryRows) {
        const metadata = metadataWithArchiveMarker({
          metadata: parseJsonObject(row.metadata_json),
          archivedAt,
          reason: input.reason,
        });
        stmt.run(archivedAt, JSON.stringify(metadata), input.profileId, row.id);
        syncMemoryFts(row.id);
      }
    });
    tx(rows);
    return ids;
  }

  function addWorldBelief(input: AddWorldBeliefInput): WorldBeliefRecord {
    initialize();
    const createdAt = nowIso();
    const beliefId = id("belief");
    db.prepare(
      `INSERT INTO gmos_world_beliefs (
        id, profile_id, subject, predicate, object, confidence, status,
        source_memory_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      beliefId,
      input.profileId,
      input.subject,
      input.predicate,
      input.object,
      input.confidence ?? 0.5,
      input.sourceMemoryId ?? null,
      createdAt,
      createdAt,
    );
    return {
      id: beliefId,
      profileId: input.profileId,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      confidence: input.confidence ?? 0.5,
      status: "active",
      sourceMemoryId: input.sourceMemoryId ?? null,
      createdAt,
      updatedAt: createdAt,
    };
  }

  function searchMemories(input: MemorySearchInput): MemoryRecord[] {
    initialize();
    const query = input.query?.trim() ?? "";
    return memoryRowsForSearch(input)
      .map(normalizeMemory)
      .filter((memory) => input.includePerson || memory.kind !== "person")
      .filter(
        (memory) =>
          input.purpose !== "context" ||
          !shouldHideFromOrdinaryContext({
            sensitivity: memory.sensitivity,
            includeSensitive: input.includeSensitive,
          }),
      )
      .map((memory) => ({ memory, score: query ? scoreMemory(memory, query) : memory.confidence }))
      .filter((item) => !query || item.score > item.memory.confidence)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit ?? 12)
      .map((item) => item.memory);
  }

  function listMemories(input: MemoryListInput): MemoryRecord[] {
    initialize();
    const query = input.query?.trim() ?? "";
    return memoryRowsForList(input)
      .map(normalizeMemory)
      .filter((memory) =>
        visibleMemory({
          memory,
          includeSensitive: input.includeSensitive,
          includePerson: input.includePerson,
        }),
      )
      .map((memory) => ({ memory, score: query ? scoreMemory(memory, query) : memory.confidence }))
      .filter((item) => !query || item.score > item.memory.confidence)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit(input.limit, 100, 500))
      .map((item) => item.memory);
  }

  function getMemoryById(
    profileId: string,
    memoryId: string,
    options: {
      includeSensitive?: boolean | undefined;
      includePerson?: boolean | undefined;
      includeArchived?: boolean | undefined;
    } = {},
  ): MemoryRecord | null {
    initialize();
    const row = db
      .prepare(
        `SELECT * FROM gmos_memories
         WHERE profile_id = ? AND id = ?
           ${options.includeArchived ? "" : "AND status = 'active'"}`,
      )
      .get(profileId, memoryId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const memory = normalizeMemory(row);
    return visibleMemory({
      memory,
      includeSensitive: options.includeSensitive,
      includePerson: options.includePerson,
    })
      ? memory
      : null;
  }

  function findActiveMemoryByMetadata(
    profileId: string,
    key: string,
    value: string,
  ): MemoryRecord | null {
    initialize();
    const row = db
      .prepare(
        `SELECT * FROM gmos_memories
         WHERE profile_id = ? AND status = 'active'
           AND json_extract(metadata_json, ?) = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(profileId, `$.${key}`, value) as Record<string, unknown> | undefined;
    return row ? normalizeMemory(row) : null;
  }

  function archiveStaleHostImports(input: ArchiveStaleHostImportsInput): string[] {
    initialize();
    const archivedAt = input.archivedAt ?? nowIso();
    const activeKeys = [...new Set(input.activeImportKeys)];
    const activeKeyClause =
      activeKeys.length > 0
        ? `AND json_extract(metadata_json, '$.hostImportKey') NOT IN (${activeKeys.map(() => "?").join(", ")})`
        : "";
    const candidates = db
      .prepare(
        `SELECT id FROM gmos_memories
         WHERE profile_id = ?
           AND status = 'active'
           AND json_extract(metadata_json, '$.hostSnapshotImport') = 1
           AND json_extract(metadata_json, '$.hostImportSourceType') = ?
           ${activeKeyClause}`,
      )
      .all(input.profileId, input.sourceType, ...activeKeys) as Array<{ id: string }>;
    const ids = candidates.map((row) => row.id);
    if (ids.length === 0) return [];
    const stmt = db.prepare(
      "UPDATE gmos_memories SET status = 'archived', updated_at = ? WHERE id = ?",
    );
    const tx = db.transaction((memoryIds: string[]) => {
      for (const memoryId of memoryIds) {
        stmt.run(archivedAt, memoryId);
        syncMemoryFts(memoryId);
      }
    });
    tx(ids);
    return ids;
  }

  function listActionPolicies(
    profileId: string,
    options: { includeSensitive?: boolean | undefined } = {},
  ): ActionPolicy[] {
    initialize();
    const rows = db
      .prepare(
        `SELECT * FROM gmos_memories
         WHERE profile_id = ? AND status = 'active' AND kind IN ('boundary', 'preference', 'procedure')
         ORDER BY updated_at DESC
         LIMIT 50`,
      )
      .all(profileId) as Record<string, unknown>[];
    return rows
      .map(normalizeMemory)
      .filter(
        (memory) =>
          !shouldHideFromOrdinaryContext({
            sensitivity: memory.sensitivity,
            includeSensitive: options.includeSensitive,
          }),
      )
      .map((memory) => {
        const kind =
          memory.kind === "boundary"
            ? "do_not_push"
            : memory.kind === "procedure"
              ? "procedure"
              : "prefer";
        return {
          id: `policy_${memory.id}`,
          kind,
          text: memory.content,
          priority: kind === "do_not_push" ? 100 : 50,
          sourceMemoryId: memory.id,
        };
      });
  }

  function listEvidenceForMemory(memoryId: string): EvidenceEvent[] {
    initialize();
    const row = db
      .prepare("SELECT source_event_id FROM gmos_memories WHERE id = ?")
      .get(memoryId) as { source_event_id?: string | null } | undefined;
    if (!row?.source_event_id) return [];
    return (
      db
        .prepare("SELECT * FROM gmos_evidence_events WHERE id = ?")
        .all(row.source_event_id) as Record<string, unknown>[]
    ).map(normalizeEvidence);
  }

  function forget(input: ForgetInput & { profileId: string }): ForgetResult {
    initialize();
    const matches = searchMemories({
      profileId: input.profileId,
      query: input.query,
      purpose: "delete",
      includeSensitive: true,
      includePerson: true,
      limit: 100,
    });
    const archivedMemoryIds = matches.map((memory) => memory.id);
    if (archivedMemoryIds.length > 0) {
      const stmt = db.prepare(
        "UPDATE gmos_memories SET status = 'archived', updated_at = ? WHERE id = ?",
      );
      const archivedAt = nowIso();
      const tx = db.transaction((ids: string[]) => {
        for (const memoryId of ids) {
          stmt.run(archivedAt, memoryId);
          syncMemoryFts(memoryId);
        }
      });
      tx(archivedMemoryIds);
    }
    return { archivedMemoryIds };
  }

  function recordFailure(input: RecordFailureInput): void {
    initialize();
    db.prepare(
      `INSERT INTO gmos_failure_events (
        id, profile_id, failure_kind, content, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id("failure"),
      input.profileId,
      input.failureKind,
      input.content,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt ?? nowIso(),
    );
  }

  function listFailures(input: ListFailuresInput): FailureEventRecord[] {
    if (!tableExists("gmos_failure_events")) return [];
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const where = input.failureKind
      ? "WHERE profile_id = ? AND failure_kind = ?"
      : "WHERE profile_id = ?";
    const params = input.failureKind
      ? [input.profileId, input.failureKind, limit]
      : [input.profileId, limit];
    return (
      db
        .prepare(
          `SELECT * FROM gmos_failure_events
           ${where}
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(...params) as Record<string, unknown>[]
    ).map(normalizeFailure);
  }

  function recordTaskTrajectory(input: TaskTrajectoryInput): void {
    initialize();
    db.prepare(
      `INSERT INTO gmos_task_trajectories (
        id, profile_id, task_id, objective, status, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id("trajectory"),
      input.profileId,
      input.taskId ?? null,
      input.objective,
      input.status,
      input.summary ?? null,
      input.createdAt ?? nowIso(),
    );
  }

  function rowCounts(): Record<string, number> {
    const tables = [
      "gmos_evidence_events",
      "gmos_memories",
      "gmos_world_beliefs",
      "gmos_failure_events",
      "gmos_task_trajectories",
    ];
    return Object.fromEntries(
      tables.map((table) => [
        table,
        tableExists(table)
          ? Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
          : 0,
      ]),
    );
  }

  function schemaVersion(): number {
    return sqliteSchemaVersion(db);
  }

  return {
    initialize,
    close() {
      if (!options.handle) db.close();
    },
    recordEvidence,
    addMemory,
    updateMemory,
    archiveMemoryById,
    restoreArchivedMemory,
    archiveMemories,
    addWorldBelief,
    searchMemories,
    listMemories,
    getMemoryById,
    findActiveMemoryByMetadata,
    archiveStaleHostImports,
    listActionPolicies,
    listEvidenceForMemory,
    forget,
    recordFailure,
    listFailures,
    recordTaskTrajectory,
    rowCounts,
    schemaVersion,
    searchIndexStatus,
    repairSearchIndex,
  };
}
