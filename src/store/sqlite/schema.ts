import type Database from "better-sqlite3";

export const GMOS_SQLITE_SCHEMA_VERSION = 4;

function columnExists(db: Database.Database, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => {
      const record = row as { name?: unknown };
      return record.name === column;
    });
}

export function ensureSqliteSchema(db: Database.Database): void {
  const previousSchemaVersion = sqliteSchemaVersion(db);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

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

    CREATE VIRTUAL TABLE IF NOT EXISTS gmos_associations_fts USING fts5(
      id UNINDEXED,
      profile_id UNINDEXED,
      status UNINDEXED,
      target_type UNINDEXED,
      cue,
      tag,
      target_summary,
      tokenize = 'unicode61'
    );

    INSERT OR IGNORE INTO gmos_schema_migrations(version, name, applied_at)
      VALUES (
        3,
        'associative_reconstruction_index',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
  `);

  if (!columnExists(db, "gmos_world_beliefs", "metadata_json")) {
    db.exec("ALTER TABLE gmos_world_beliefs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';");
  }
  db.exec(`
    INSERT OR IGNORE INTO gmos_schema_migrations(version, name, applied_at)
      VALUES (
        4,
        'world_belief_entity_metadata',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
  `);

  if (previousSchemaVersion < 2) {
    db.exec(`
      DELETE FROM gmos_memories_fts;
      INSERT INTO gmos_memories_fts(id, profile_id, kind, scope, status, content)
        SELECT id, profile_id, kind, scope, status, content
        FROM gmos_memories;
    `);
  }
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
