import type Database from "better-sqlite3";

export function ensureSqliteSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

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

    CREATE TABLE IF NOT EXISTS gmos_world_beliefs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      source_memory_id TEXT,
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
  `);
}

