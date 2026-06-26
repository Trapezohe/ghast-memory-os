import { classifySensitivity } from "./safety.js";

export interface EntityResolutionInput {
  subject: string;
  predicate?: string | undefined;
  aliases?: string[] | undefined;
}

export interface EntityResolutionResult {
  canonicalSubject: string;
  originalSubject: string;
  entityKind: string | null;
  entityKey: string | null;
  aliases: string[];
}

const PREFIX_KINDS = new Set([
  "project",
  "repo",
  "repository",
  "task",
  "objective",
  "routine",
  "procedure",
  "user",
  "person",
]);

function compact(input: string): string {
  return input.replace(/\s+/gu, " ").trim();
}

function key(input: string): string {
  return compact(input)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = compact(value);
    const dedupeKey = normalized.toLowerCase();
    if (!normalized || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push(normalized);
  }
  return result;
}

function publicAlias(value: string): string {
  return classifySensitivity(value) === "normal" ? value : "";
}

function kindFromPredicate(predicate: string | undefined): string | null {
  if (!predicate) return null;
  const prefix = predicate.split(".")[0]?.toLowerCase();
  if (!prefix) return null;
  if (prefix === "repository") return "repo";
  return PREFIX_KINDS.has(prefix) ? prefix : null;
}

function prefixedSubject(subject: string): { kind: string; rawKey: string } | null {
  const match = subject.match(/^([a-z][a-z0-9_-]{1,24})\s*[:/]\s*(.+)$/iu);
  if (!match) return null;
  const kind = match[1]?.toLowerCase();
  const rawKey = compact(match[2] ?? "");
  if (!kind || !rawKey || !PREFIX_KINDS.has(kind)) return null;
  return { kind: kind === "repository" ? "repo" : kind, rawKey };
}

function projectPhraseSubject(subject: string): string | null {
  const trimmed = compact(subject);
  const patterns = [
    /^(.+?)\s+(?:project|repo|repository)$/iu,
    /^(?:project|repo|repository)\s+(.+)$/iu,
    /^(.+?)\s*项目$/u,
    /^项目\s*(.+)$/u,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const rawKey = compact(match?.[1] ?? "");
    if (rawKey) return rawKey;
  }
  return null;
}

export function resolveWorldEntitySubject(input: EntityResolutionInput): EntityResolutionResult {
  const originalSubject = compact(input.subject) || "user";
  const explicit = prefixedSubject(originalSubject);
  const projectPhrase = explicit ? null : projectPhraseSubject(originalSubject);
  const inferredKind = explicit?.kind ?? (projectPhrase ? "project" : kindFromPredicate(input.predicate));
  const rawKey =
    explicit?.rawKey ?? projectPhrase ?? (inferredKind === "user" ? "user" : originalSubject);
  const entityKey = key(rawKey);
  const canonicalSubject =
    inferredKind && inferredKind !== "user" && entityKey
      ? `${inferredKind}:${entityKey}`
      : inferredKind === "user"
        ? "user"
        : originalSubject;
  const aliases = unique([
    originalSubject,
    ...(input.aliases ?? []),
    canonicalSubject,
    entityKey ?? "",
    inferredKind === "project" && entityKey ? `${entityKey} project` : "",
    inferredKind === "project" && entityKey ? `project ${entityKey}` : "",
    inferredKind === "project" && entityKey ? `${entityKey} 项目` : "",
    inferredKind === "project" && entityKey ? `项目 ${entityKey}` : "",
  ].map(publicAlias));
  return {
    canonicalSubject,
    originalSubject,
    entityKind: inferredKind,
    entityKey: entityKey || null,
    aliases,
  };
}

export function entityResolutionMetadata(
  resolution: EntityResolutionResult,
): Record<string, unknown> {
  return {
    canonicalSubject: resolution.canonicalSubject,
    originalSubject: resolution.originalSubject,
    aliases: resolution.aliases,
    ...(resolution.entityKind ? { kind: resolution.entityKind } : {}),
    ...(resolution.entityKey ? { key: resolution.entityKey } : {}),
  };
}
