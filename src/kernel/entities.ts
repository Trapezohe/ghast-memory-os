import { classifySensitivity } from "./safety.js";
import { stableNamedPersonSubject } from "./extraction.js";

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

export type EntityMentionRole =
  | "subject"
  | "subject_alias"
  | "source_speaker"
  | "source_speaker_alias"
  | "participant";

export interface EntityMention {
  role: EntityMentionRole;
  value: string;
  key: string;
  kind: string;
  cueEligible: boolean;
}

export interface EntityMentionInput {
  subject?: string | undefined;
  predicate?: string | undefined;
  subjectAliases?: string[] | undefined;
  sourceMetadata?: Record<string, unknown> | undefined;
}

const ASSOCIATION_CUE_ENTITY_MENTION_ROLES = new Set<EntityMentionRole>([
  "subject",
  "subject_alias",
  "source_speaker",
  "source_speaker_alias",
]);

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

function publicEntityValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const compacted = compact(value);
  if (/^\[redacted_[a-z_]+\]$/iu.test(compacted)) return "";
  if (!compacted || classifySensitivity(compacted) !== "normal") return "";
  return compacted;
}

function publicStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(publicEntityValue).filter(Boolean) : [];
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

function personSubjectValue(value: string): string {
  return compact(value.match(/^person\s*[:/]\s*(.+)$/iu)?.[1] ?? value);
}

function mentionKey(value: string): string {
  return key(value);
}

function addMention(
  mentions: EntityMention[],
  input: {
    role: EntityMentionRole;
    value: string;
    kind: string;
    cueEligible: boolean;
  },
): void {
  const value = publicEntityValue(input.value);
  const mentionKeyValue = mentionKey(value);
  if (mentionKeyValue.length < 2) return;
  const existing = mentions.find(
    (mention) => mention.role === input.role && mention.key === mentionKeyValue,
  );
  if (existing) {
    existing.cueEligible = existing.cueEligible || input.cueEligible;
    return;
  }
  mentions.push({
    role: input.role,
    value,
    key: mentionKeyValue,
    kind: input.kind,
    cueEligible: input.cueEligible,
  });
}

export function buildEntityMentions(input: EntityMentionInput): EntityMention[] {
  const mentions: EntityMention[] = [];
  if (input.subject) {
    const resolution = resolveWorldEntitySubject({
      subject: input.subject,
      predicate: input.predicate,
      aliases: input.subjectAliases,
    });
    if (resolution.entityKind && resolution.entityKind !== "user") {
      const subjectValue =
        resolution.entityKind === "person"
          ? personSubjectValue(resolution.originalSubject)
          : resolution.entityKey ?? resolution.originalSubject;
      addMention(mentions, {
        role: "subject",
        value: subjectValue,
        kind: resolution.entityKind,
        cueEligible: true,
      });
      for (const alias of resolution.aliases) {
        const value = resolution.entityKind === "person" ? personSubjectValue(alias) : alias;
        addMention(mentions, {
          role: "subject_alias",
          value,
          kind: resolution.entityKind,
          cueEligible: true,
        });
      }
    }
  }

  const sourceMetadata = input.sourceMetadata ?? {};
  const speaker = publicEntityValue(sourceMetadata.speaker);
  if (speaker && stableNamedPersonSubject(speaker)) {
    addMention(mentions, {
      role: "source_speaker",
      value: speaker,
      kind: "person",
      cueEligible: true,
    });
  }
  for (const alias of publicStringArray(sourceMetadata.speakerAliases)) {
    if (!stableNamedPersonSubject(alias)) continue;
    addMention(mentions, {
      role: "source_speaker_alias",
      value: alias,
      kind: "person",
      cueEligible: true,
    });
  }
  for (const participant of publicStringArray(sourceMetadata.participants)) {
    if (!stableNamedPersonSubject(participant)) continue;
    addMention(mentions, {
      role: "participant",
      value: participant,
      kind: "person",
      cueEligible: false,
    });
  }
  return mentions;
}

export function entityMentionCues(metadata: Record<string, unknown>): string[] {
  const mentions = metadata.entityMentions;
  if (!Array.isArray(mentions)) return [];
  return unique(
    mentions.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      if (record.cueEligible !== true) return [];
      if (
        typeof record.role !== "string" ||
        !ASSOCIATION_CUE_ENTITY_MENTION_ROLES.has(record.role as EntityMentionRole)
      ) {
        return [];
      }
      return [publicEntityValue(record.value)];
    }),
  );
}
