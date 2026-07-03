import type Database from "better-sqlite3";

export const GMOS_SQLITE_SCHEMA_VERSION = 10;

const READ_AUDIT_REVISION_TABLES = [
  "gmos_evidence_events",
  "gmos_memories",
  "gmos_world_beliefs",
  "gmos_failure_events",
  "gmos_task_trajectories",
  "gmos_associations",
  "gmos_memory_vectors",
  "gmos_memory_vector_terms",
] as const;

function columnExists(db: Database.Database, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => {
      const record = row as { name?: unknown };
      return record.name === column;
    });
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return row?.name === table;
}

function schemaMigrationApplied(db: Database.Database, version: number): boolean {
  if (!tableExists(db, "gmos_schema_migrations")) return false;
  const row = db
    .prepare("SELECT version FROM gmos_schema_migrations WHERE version = ?")
    .get(version) as { version?: number } | undefined;
  return row?.version === version;
}

function quotedIdentifier(input: string): string {
  return `"${input.replaceAll('"', '""')}"`;
}

function sqliteObjectSql(db: Database.Database, name: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
    .get(name) as { sql?: string | null } | undefined;
  return row?.sql ?? "";
}

function ftsUsesExternalContent(
  db: Database.Database,
  table: string,
  contentTable: string,
): boolean {
  const sql = sqliteObjectSql(db, table).replace(/\s+/gu, " ").toLowerCase();
  return (
    sql.includes(`content='${contentTable.toLowerCase()}'`) &&
    sql.includes("content_rowid='rowid'")
  );
}

function ensureMemoryFtsTriggers(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_gmos_memories_fts_ai;
    DROP TRIGGER IF EXISTS trg_gmos_memories_fts_ad;
    DROP TRIGGER IF EXISTS trg_gmos_memories_fts_au;

    CREATE TRIGGER trg_gmos_memories_fts_ai
      AFTER INSERT ON gmos_memories
      BEGIN
        INSERT INTO gmos_memories_fts(rowid, id, profile_id, kind, scope, status, content)
          VALUES (new.rowid, new.id, new.profile_id, new.kind, new.scope, new.status, new.content);
      END;

    CREATE TRIGGER trg_gmos_memories_fts_ad
      AFTER DELETE ON gmos_memories
      BEGIN
        INSERT INTO gmos_memories_fts(
          gmos_memories_fts, rowid, id, profile_id, kind, scope, status, content
        ) VALUES (
          'delete', old.rowid, old.id, old.profile_id, old.kind, old.scope, old.status, old.content
        );
      END;

    CREATE TRIGGER trg_gmos_memories_fts_au
      AFTER UPDATE ON gmos_memories
      BEGIN
        INSERT INTO gmos_memories_fts(
          gmos_memories_fts, rowid, id, profile_id, kind, scope, status, content
        ) VALUES (
          'delete', old.rowid, old.id, old.profile_id, old.kind, old.scope, old.status, old.content
        );
        INSERT INTO gmos_memories_fts(rowid, id, profile_id, kind, scope, status, content)
          VALUES (new.rowid, new.id, new.profile_id, new.kind, new.scope, new.status, new.content);
      END;
  `);
}

function ensureAssociationFtsTriggers(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_gmos_associations_fts_ai;
    DROP TRIGGER IF EXISTS trg_gmos_associations_fts_ad;
    DROP TRIGGER IF EXISTS trg_gmos_associations_fts_au;

    CREATE TRIGGER trg_gmos_associations_fts_ai
      AFTER INSERT ON gmos_associations
      BEGIN
        INSERT INTO gmos_associations_fts(
          rowid, id, profile_id, status, target_type, cue, tag, target_summary
        ) VALUES (
          new.rowid, new.id, new.profile_id, new.status, new.target_type,
          new.cue, new.tag, new.target_summary
        );
      END;

    CREATE TRIGGER trg_gmos_associations_fts_ad
      AFTER DELETE ON gmos_associations
      BEGIN
        INSERT INTO gmos_associations_fts(
          gmos_associations_fts, rowid, id, profile_id, status, target_type,
          cue, tag, target_summary
        ) VALUES (
          'delete', old.rowid, old.id, old.profile_id, old.status, old.target_type,
          old.cue, old.tag, old.target_summary
        );
      END;

    CREATE TRIGGER trg_gmos_associations_fts_au
      AFTER UPDATE ON gmos_associations
      BEGIN
        INSERT INTO gmos_associations_fts(
          gmos_associations_fts, rowid, id, profile_id, status, target_type,
          cue, tag, target_summary
        ) VALUES (
          'delete', old.rowid, old.id, old.profile_id, old.status, old.target_type,
          old.cue, old.tag, old.target_summary
        );
        INSERT INTO gmos_associations_fts(
          rowid, id, profile_id, status, target_type, cue, tag, target_summary
        ) VALUES (
          new.rowid, new.id, new.profile_id, new.status, new.target_type,
          new.cue, new.tag, new.target_summary
        );
      END;
  `);
}

function createMemoryFts(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS gmos_memories_fts USING fts5(
      id UNINDEXED,
      profile_id UNINDEXED,
      kind UNINDEXED,
      scope UNINDEXED,
      status UNINDEXED,
      content,
      content='gmos_memories',
      content_rowid='rowid',
      tokenize = 'unicode61'
    );
  `);
}

function createAssociationFts(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS gmos_associations_fts USING fts5(
      id UNINDEXED,
      profile_id UNINDEXED,
      status UNINDEXED,
      target_type UNINDEXED,
      cue,
      tag,
      target_summary,
      content='gmos_associations',
      content_rowid='rowid',
      tokenize = 'unicode61'
    );
  `);
}

function rebuildExternalContentFts(db: Database.Database, table: string): void {
  db.prepare(
    `INSERT INTO ${quotedIdentifier(table)}(${quotedIdentifier(table)}) VALUES('rebuild')`,
  ).run();
}

function ensureExternalContentFtsSchema(
  db: Database.Database,
  previousSchemaVersion: number,
): void {
  const needsMemoryFtsRebuild =
    previousSchemaVersion < 10 ||
    !schemaMigrationApplied(db, 10) ||
    !ftsUsesExternalContent(db, "gmos_memories_fts", "gmos_memories");
  const needsAssociationFtsRebuild =
    previousSchemaVersion < 10 ||
    !schemaMigrationApplied(db, 10) ||
    !ftsUsesExternalContent(db, "gmos_associations_fts", "gmos_associations");

  if (needsMemoryFtsRebuild) {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_gmos_memories_fts_ai;
      DROP TRIGGER IF EXISTS trg_gmos_memories_fts_ad;
      DROP TRIGGER IF EXISTS trg_gmos_memories_fts_au;
      DROP TABLE IF EXISTS gmos_memories_fts;
    `);
    createMemoryFts(db);
  }
  if (needsAssociationFtsRebuild) {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_gmos_associations_fts_ai;
      DROP TRIGGER IF EXISTS trg_gmos_associations_fts_ad;
      DROP TRIGGER IF EXISTS trg_gmos_associations_fts_au;
      DROP TABLE IF EXISTS gmos_associations_fts;
    `);
    createAssociationFts(db);
  }

  ensureMemoryFtsTriggers(db);
  ensureAssociationFtsTriggers(db);

  if (needsMemoryFtsRebuild) rebuildExternalContentFts(db, "gmos_memories_fts");
  if (needsAssociationFtsRebuild) rebuildExternalContentFts(db, "gmos_associations_fts");

  db.exec(`
    INSERT OR IGNORE INTO gmos_schema_migrations(version, name, applied_at)
      VALUES (
        10,
        'external_content_fts',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
  `);
}

function ensureReadAuditRevisionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gmos_read_audit_revisions (
      table_name TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  for (const table of READ_AUDIT_REVISION_TABLES) {
    db.exec(`
      INSERT OR IGNORE INTO gmos_read_audit_revisions(table_name, revision, updated_at)
        VALUES (
          '${table}',
          COALESCE((SELECT COUNT(*) FROM ${quotedIdentifier(table)}), 0),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        );

      CREATE TRIGGER IF NOT EXISTS ${quotedIdentifier(`trg_${table}_read_audit_insert`)}
        AFTER INSERT ON ${quotedIdentifier(table)}
        BEGIN
          INSERT INTO gmos_read_audit_revisions(table_name, revision, updated_at)
            VALUES ('${table}', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT(table_name) DO UPDATE SET
              revision = revision + 1,
              updated_at = excluded.updated_at;
        END;

      CREATE TRIGGER IF NOT EXISTS ${quotedIdentifier(`trg_${table}_read_audit_update`)}
        AFTER UPDATE ON ${quotedIdentifier(table)}
        BEGIN
          INSERT INTO gmos_read_audit_revisions(table_name, revision, updated_at)
            VALUES ('${table}', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT(table_name) DO UPDATE SET
              revision = revision + 1,
              updated_at = excluded.updated_at;
        END;

      CREATE TRIGGER IF NOT EXISTS ${quotedIdentifier(`trg_${table}_read_audit_delete`)}
        AFTER DELETE ON ${quotedIdentifier(table)}
        BEGIN
          INSERT INTO gmos_read_audit_revisions(table_name, revision, updated_at)
            VALUES ('${table}', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT(table_name) DO UPDATE SET
              revision = revision + 1,
              updated_at = excluded.updated_at;
        END;
    `);
  }
}

export function ensureSqliteSchema(db: Database.Database): void {
  const previousSchemaVersion = sqliteSchemaVersion(db);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA recursive_triggers = ON;

    CREATE TABLE IF NOT EXISTS gmos_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gmos_evidence_events (
      id TEXT PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      profile_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_uri TEXT,
      content TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      eligible_for_long_term_memory INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gmos_evidence_profile_time
      ON gmos_evidence_events(profile_id, created_at);

    CREATE TABLE IF NOT EXISTS gmos_memories (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      content TEXT NOT NULL,
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.5,
      recall_count INTEGER NOT NULL DEFAULT 0,
      last_recalled_at TEXT,
      reinforcement REAL NOT NULL DEFAULT 0,
      source_event_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gmos_memories_profile_kind_status
      ON gmos_memories(profile_id, kind, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_gmos_memories_profile_status_time
      ON gmos_memories(profile_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS gmos_world_beliefs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      source_memory_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gmos_world_beliefs_profile_predicate
      ON gmos_world_beliefs(profile_id, predicate, status, updated_at);

    CREATE TABLE IF NOT EXISTS gmos_failure_events (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      failure_kind TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gmos_failures_profile_kind
      ON gmos_failure_events(profile_id, failure_kind, created_at);

    CREATE TABLE IF NOT EXISTS gmos_task_trajectories (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      task_id TEXT,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gmos_task_trajectories_profile
      ON gmos_task_trajectories(profile_id, status, created_at);

    INSERT OR IGNORE INTO gmos_schema_migrations(version, name, applied_at)
      VALUES (
        1,
        'baseline',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );

    CREATE VIRTUAL TABLE IF NOT EXISTS gmos_memories_fts USING fts5(
      id UNINDEXED,
      profile_id UNINDEXED,
      kind UNINDEXED,
      scope UNINDEXED,
      status UNINDEXED,
      content,
      content='gmos_memories',
      content_rowid='rowid',
      tokenize = 'unicode61'
    );

    INSERT OR IGNORE INTO gmos_schema_migrations(version, name, applied_at)
      VALUES (
        2,
        'memory_fts_search',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );

    CREATE TABLE IF NOT EXISTS gmos_associations (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      cue TEXT NOT NULL,
      cue_kind TEXT NOT NULL,
      tag TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_summary TEXT NOT NULL,
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.5,
      source_memory_id TEXT,
      source_belief_id TEXT,
      source_task_trajectory_id TEXT,
      source_evidence_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(profile_id, cue, tag, target_type, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gmos_associations_profile_cue
      ON gmos_associations(profile_id, cue, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_gmos_associations_profile_target
      ON gmos_associations(profile_id, target_type, target_id, status);
    CREATE INDEX IF NOT EXISTS idx_gmos_associations_source_memory
      ON gmos_associations(source_memory_id);
    CREATE INDEX IF NOT EXISTS idx_gmos_associations_source_belief
      ON gmos_associations(source_belief_id);
    CREATE INDEX IF NOT EXISTS idx_gmos_associations_source_task_trajectory
      ON gmos_associations(source_task_trajectory_id);
    CREATE INDEX IF NOT EXISTS idx_gmos_associations_target_id
      ON gmos_associations(target_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS gmos_associations_fts USING fts5(
      id UNINDEXED,
      profile_id UNINDEXED,
      status UNINDEXED,
      target_type UNINDEXED,
      cue,
      tag,
      target_summary,
      content='gmos_associations',
      content_rowid='rowid',
      tokenize = 'unicode61'
    );

    INSERT OR IGNORE INTO gmos_schema_migrations(version, name, applied_at)
      VALUES (
        3,
        'associative_reconstruction_index',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );

    CREATE TABLE IF NOT EXISTS gmos_memory_vectors (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_name TEXT NOT NULL DEFAULT 'local-hash-v1',
      embedding_status TEXT NOT NULL DEFAULT 'embedded',
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gmos_memory_vectors_profile_status
      ON gmos_memory_vectors(profile_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS gmos_memory_vector_terms (
      id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      status TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(id, feature_key)
    );
    CREATE INDEX IF NOT EXISTS idx_gmos_memory_vector_terms_lookup
      ON gmos_memory_vector_terms(profile_id, status, feature_key, updated_at);
  `);

  if (!columnExists(db, "gmos_world_beliefs", "metadata_json")) {
    db.exec("ALTER TABLE gmos_world_beliefs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';");
  }
  if (!columnExists(db, "gmos_memories", "recall_count")) {
    db.exec("ALTER TABLE gmos_memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0;");
  }
  if (!columnExists(db, "gmos_memories", "last_recalled_at")) {
    db.exec("ALTER TABLE gmos_memories ADD COLUMN last_recalled_at TEXT;");
  }
  if (!columnExists(db, "gmos_memories", "reinforcement")) {
    db.exec("ALTER TABLE gmos_memories ADD COLUMN reinforcement REAL NOT NULL DEFAULT 0;");
  }
  if (!columnExists(db, "gmos_memory_vectors", "provider_name")) {
    db.exec(
      "ALTER TABLE gmos_memory_vectors ADD COLUMN provider_name TEXT NOT NULL DEFAULT 'local-hash-v1';",
    );
  }
  if (!columnExists(db, "gmos_memory_vectors", "embedding_status")) {
    db.exec(
      "ALTER TABLE gmos_memory_vectors ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'embedded';",
    );
  }
  db.exec(`
    INSERT OR IGNORE INTO gmos_schema_migrations(version, name, applied_at)
      VALUES (
        4,
        'world_belief_entity_metadata',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    INSERT OR IGNORE INTO gmos_schema_migrations(version, name, applied_at)
      VALUES (
        5,
        'local_memory_vector_index',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
  `);

  ensureReadAuditRevisionSchema(db);
  db.exec(`
    INSERT OR IGNORE INTO gmos_schema_migrations(version, name, applied_at)
      VALUES (
        6,
        'read_audit_revision_triggers',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    INSERT OR IGNORE INTO gmos_schema_migrations(version, name, applied_at)
      VALUES (
        7,
        'relation_belief_association_projection',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    INSERT OR IGNORE INTO gmos_schema_migrations(version, name, applied_at)
      VALUES (
        8,
        'memory_lifecycle_signals',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    INSERT OR IGNORE INTO gmos_schema_migrations(version, name, applied_at)
      VALUES (
        9,
        'provider_aware_memory_vectors',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
  `);

  ensureExternalContentFtsSchema(db, previousSchemaVersion);
}

export function sqliteSchemaVersion(db: Database.Database): number {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gmos_schema_migrations'")
    .get() as { name?: string } | undefined;
  if (!table) return 0;
  const row = db
    .prepare("SELECT MAX(version) AS version FROM gmos_schema_migrations")
    .get() as { version?: number | null } | undefined;
  return Number(row?.version ?? 0);
}
