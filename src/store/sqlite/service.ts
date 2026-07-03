import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type Database from "better-sqlite3";

export type SqliteServiceApiKeyScope = "read" | "readwrite" | "admin";
export type SqliteServiceApiKeyProfiles = string[] | "*";

export interface SqliteServiceApiKey {
  keyId: string;
  label: string;
  scope: SqliteServiceApiKeyScope;
  profiles: SqliteServiceApiKeyProfiles;
  createdAt: string;
  revokedAt?: string | undefined;
}

export interface SqliteServiceApiKeyWithSecret {
  key: SqliteServiceApiKey;
  secret: string;
}

export interface CreateSqliteServiceApiKeyInput {
  label: string;
  scope: SqliteServiceApiKeyScope;
  profiles?: SqliteServiceApiKeyProfiles | undefined;
}

export interface SqliteServiceAuditInput {
  keyId: string;
  route: string;
  method: string;
  profileId: string;
  statusCode: number;
  timestamp: string;
  durationMs: number;
}

export interface SqliteServiceAuditRow extends SqliteServiceAuditInput {
  id: string;
}

export interface ListSqliteServiceAuditInput {
  keyId?: string | undefined;
  since?: string | undefined;
  limit?: number | undefined;
}

export interface SqliteServiceProfileSummary {
  profileId: string;
  memoryCounts: {
    active: number;
    dormant: number;
    archived: number;
  };
}

interface SqliteServiceApiKeyRow {
  key_id: string;
  hash: string;
  label: string;
  scope: string;
  profiles_json: string;
  created_at: string;
  revoked_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseProfilesJson(value: string): SqliteServiceApiKeyProfiles {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === "*") return "*";
  if (
    Array.isArray(parsed) &&
    parsed.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  ) {
    return parsed;
  }
  throw new Error("gmOS service key profiles are invalid");
}

function normalizeProfiles(input: SqliteServiceApiKeyProfiles | undefined): SqliteServiceApiKeyProfiles {
  if (input === undefined || input === "*") return "*";
  const profiles = [...new Set(input.map((profile) => profile.trim()).filter(Boolean))].sort();
  if (profiles.length === 0) throw new Error("gmOS service key profiles must not be empty");
  return profiles;
}

function profilesJson(input: SqliteServiceApiKeyProfiles): string {
  return JSON.stringify(input);
}

function normalizeScope(scope: string): SqliteServiceApiKeyScope {
  if (scope !== "read" && scope !== "readwrite" && scope !== "admin") {
    throw new Error("gmOS service key scope must be read, readwrite, or admin");
  }
  return scope;
}

function normalizeKeyRow(row: SqliteServiceApiKeyRow): SqliteServiceApiKey {
  return {
    keyId: row.key_id,
    label: row.label,
    scope: normalizeScope(row.scope),
    profiles: parseProfilesJson(row.profiles_json),
    createdAt: row.created_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function requireLabel(label: string): string {
  const normalized = label.trim();
  if (!normalized) throw new Error("gmOS service key label must not be empty");
  return normalized;
}

function serviceSecret(): string {
  return `gmos_${randomBytes(32).toString("base64url")}`;
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return row?.name === table;
}

export function createSqliteServiceApiKey(
  db: Database.Database,
  input: CreateSqliteServiceApiKeyInput,
): SqliteServiceApiKeyWithSecret {
  const secret = serviceSecret();
  const keyId = `key_${randomUUID()}`;
  const createdAt = nowIso();
  const profiles = normalizeProfiles(input.profiles);
  db.prepare(
    `INSERT INTO gmos_api_keys(
      key_id, hash, label, scope, profiles_json, created_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    keyId,
    sha256Hex(secret),
    requireLabel(input.label),
    normalizeScope(input.scope),
    profilesJson(profiles),
    createdAt,
  );
  return {
    secret,
    key: {
      keyId,
      label: requireLabel(input.label),
      scope: input.scope,
      profiles,
      createdAt,
    },
  };
}

export function listSqliteServiceApiKeys(db: Database.Database): SqliteServiceApiKey[] {
  if (!tableExists(db, "gmos_api_keys")) return [];
  return (
    db
      .prepare(
        `SELECT key_id, hash, label, scope, profiles_json, created_at, revoked_at
         FROM gmos_api_keys
         ORDER BY created_at ASC, key_id ASC`,
      )
      .all() as SqliteServiceApiKeyRow[]
  ).map(normalizeKeyRow);
}

export function revokeSqliteServiceApiKey(
  db: Database.Database,
  keyId: string,
): SqliteServiceApiKey | null {
  const revokedAt = nowIso();
  db.prepare(
    `UPDATE gmos_api_keys
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE key_id = ?`,
  ).run(revokedAt, keyId);
  const row = db
    .prepare(
      `SELECT key_id, hash, label, scope, profiles_json, created_at, revoked_at
       FROM gmos_api_keys
       WHERE key_id = ?`,
    )
    .get(keyId) as SqliteServiceApiKeyRow | undefined;
  return row ? normalizeKeyRow(row) : null;
}

export function authenticateSqliteServiceApiKey(
  db: Database.Database,
  secret: string,
): SqliteServiceApiKey | null {
  const hash = sha256Hex(secret);
  const rows = db
    .prepare(
      `SELECT key_id, hash, label, scope, profiles_json, created_at, revoked_at
       FROM gmos_api_keys
       WHERE revoked_at IS NULL
       ORDER BY created_at ASC, key_id ASC`,
    )
    .all() as SqliteServiceApiKeyRow[];
  for (const row of rows) {
    if (constantTimeHexEqual(hash, row.hash)) return normalizeKeyRow(row);
  }
  return null;
}

export function sqliteServiceApiKeyCount(db: Database.Database): number {
  if (!tableExists(db, "gmos_api_keys")) return 0;
  return Number(
    (db.prepare("SELECT COUNT(*) AS count FROM gmos_api_keys").get() as { count: number }).count,
  );
}

export function recordSqliteServiceAudit(
  db: Database.Database,
  input: SqliteServiceAuditInput,
): void {
  db.prepare(
    `INSERT INTO gmos_http_audit_log(
      id, key_id, route, method, profile_id, status_code, timestamp, duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `audit_${randomUUID()}`,
    input.keyId,
    input.route,
    input.method,
    input.profileId,
    input.statusCode,
    input.timestamp,
    input.durationMs,
  );
}

export function listSqliteServiceAuditRows(
  db: Database.Database,
  input: ListSqliteServiceAuditInput = {},
): SqliteServiceAuditRow[] {
  if (!tableExists(db, "gmos_http_audit_log")) return [];
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.keyId) {
    clauses.push("key_id = ?");
    params.push(input.keyId);
  }
  if (input.since) {
    clauses.push("timestamp >= ?");
    params.push(input.since);
  }
  const limit = input.limit ?? 100;
  const rows = db
    .prepare(
      `SELECT id, key_id, route, method, profile_id, status_code, timestamp, duration_ms
       FROM gmos_http_audit_log
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY timestamp DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: string;
    key_id: string;
    route: string;
    method: string;
    profile_id: string;
    status_code: number;
    timestamp: string;
    duration_ms: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    keyId: row.key_id,
    route: row.route,
    method: row.method,
    profileId: row.profile_id,
    statusCode: Number(row.status_code),
    timestamp: row.timestamp,
    durationMs: Number(row.duration_ms),
  }));
}

export function pruneSqliteServiceAuditRows(
  db: Database.Database,
  retentionDays: number,
  now: Date = new Date(),
): number {
  if (!tableExists(db, "gmos_http_audit_log")) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare("DELETE FROM gmos_http_audit_log WHERE timestamp < ?").run(cutoff).changes;
}

export function ensureSqliteServiceProfile(
  db: Database.Database,
  profileId: string,
): SqliteServiceProfileSummary {
  const normalized = profileId.trim();
  if (!normalized) throw new Error("gmOS service profile id must not be empty");
  db.prepare(
    `INSERT OR IGNORE INTO gmos_profiles(profile_id, created_at)
     VALUES (?, ?)`,
  ).run(normalized, nowIso());
  return (
    listSqliteServiceProfiles(db).find((profile) => profile.profileId === normalized) ?? {
      profileId: normalized,
      memoryCounts: { active: 0, dormant: 0, archived: 0 },
    }
  );
}

export function listSqliteServiceProfiles(db: Database.Database): SqliteServiceProfileSummary[] {
  const profileIds = new Set<string>();
  for (const table of [
    "gmos_profiles",
    "gmos_memories",
    "gmos_evidence_events",
    "gmos_world_beliefs",
    "gmos_failure_events",
    "gmos_task_trajectories",
  ]) {
    if (!tableExists(db, table)) continue;
    for (const row of db
      .prepare(`SELECT DISTINCT profile_id FROM ${table}`)
      .all() as Array<{ profile_id?: string }>) {
      if (row.profile_id) profileIds.add(row.profile_id);
    }
  }
  const counts = new Map<string, SqliteServiceProfileSummary["memoryCounts"]>();
  if (tableExists(db, "gmos_memories")) {
    for (const row of db
      .prepare(
        `SELECT profile_id, status, COUNT(*) AS count
         FROM gmos_memories
         GROUP BY profile_id, status`,
      )
      .all() as Array<{ profile_id: string; status: string; count: number }>) {
      const bucket = counts.get(row.profile_id) ?? { active: 0, dormant: 0, archived: 0 };
      if (row.status === "active" || row.status === "dormant" || row.status === "archived") {
        bucket[row.status] = Number(row.count);
      }
      counts.set(row.profile_id, bucket);
    }
  }
  return [...profileIds]
    .sort((left, right) => left.localeCompare(right))
    .map((profileId) => ({
      profileId,
      memoryCounts: counts.get(profileId) ?? { active: 0, dormant: 0, archived: 0 },
    }));
}
