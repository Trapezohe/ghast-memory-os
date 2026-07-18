import { createHash } from "node:crypto";

import type {
  MemoryCanonicalInstanceSnapshot,
  MemoryInstanceAttributes,
  MemoryInstanceKind,
  MemoryInstanceMention,
  MemoryInstanceResolverDecision,
  MemoryInstanceResolverResult,
  MemoryInstanceState,
} from "./types.js";

function normalized(value: string | undefined): string {
  return value?.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() ?? "";
}

function primary(attributes: MemoryInstanceAttributes): string {
  return normalized(attributes.target ?? attributes.entity);
}

function identityKey(input: {
  instanceKind: MemoryInstanceKind;
  attributes: MemoryInstanceAttributes;
  occurredAt?: string | undefined;
}): string | null {
  const subject = primary(input.attributes);
  if (!subject) return null;
  switch (input.instanceKind) {
    case "object":
      return `object:${subject}`;
    case "occurrence":
      return `occurrence:${subject}:${normalized(input.attributes.action)}:${input.occurredAt ?? ""}`;
    case "obligation":
      return normalized(input.attributes.action)
        ? `obligation:${subject}:${normalized(input.attributes.action)}`
        : null;
    case "value":
      return `value:${subject}:${normalized(input.attributes.action)}`;
  }
}

function validState(kind: MemoryInstanceKind, state: MemoryInstanceState): boolean {
  if (kind === "object") return ["active", "planned", "not_current", "inactive"].includes(state);
  if (kind === "occurrence") return state === "occurred" || state === "planned";
  if (kind === "obligation") return state === "pending" || state === "completed";
  return state === "current" || state === "inactive";
}

export function defaultInstanceState(
  kind: MemoryInstanceKind,
  state: MemoryInstanceState | undefined,
): MemoryInstanceState | null {
  const resolved = state ?? ({
    object: "active",
    occurrence: "occurred",
    obligation: "pending",
    value: "current",
  } satisfies Record<MemoryInstanceKind, MemoryInstanceState>)[kind];
  return validState(kind, resolved) ? resolved : null;
}

function exactInstance(
  mention: MemoryInstanceMention,
  existing: MemoryCanonicalInstanceSnapshot[],
): MemoryCanonicalInstanceSnapshot | null {
  const key = identityKey(mention);
  return key
    ? existing.find((instance) => instance.instanceKind === mention.instanceKind && identityKey(instance) === key) ?? null
    : null;
}

function countable(mention: MemoryInstanceMention): boolean {
  if (!identityKey(mention) || !defaultInstanceState(mention.instanceKind, mention.state)) return false;
  return mention.instanceKind !== "obligation" ||
    Boolean(mention.attributes.action && mention.state && (mention.attributes.target ?? mention.attributes.entity));
}

export function deterministicInstanceDecision(
  mention: MemoryInstanceMention,
  existing: MemoryCanonicalInstanceSnapshot[],
): MemoryInstanceResolverDecision | null {
  if (!countable(mention)) return { decision: "REJECTED", reason: "not_countable_instance" };
  const cited = existing.find((instance) => instance.citations.includes(mention.mentionId));
  if (cited) return { decision: "REJECTED", reason: "duplicate_of_already_merged" };
  const exact = exactInstance(mention, existing);
  if (!exact) return null;
  return mention.state && mention.state !== exact.state
    ? { decision: "STATE_TRANSITION", instanceId: exact.instanceId, state: mention.state }
    : { decision: "SAME_AS", instanceId: exact.instanceId };
}

export function validatedInstanceDecision(input: {
  mention: MemoryInstanceMention;
  existing: MemoryCanonicalInstanceSnapshot[];
  proposed: MemoryInstanceResolverResult;
}): MemoryInstanceResolverDecision | null {
  const deterministic = deterministicInstanceDecision(input.mention, input.existing);
  if (deterministic) return deterministic;
  const proposed = input.proposed;
  if (!proposed) return null;
  if (proposed.decision === "NEW_INSTANCE") return proposed;
  if (proposed.decision === "REJECTED") {
    return proposed.reason.trim() ? { decision: "REJECTED", reason: proposed.reason.trim().slice(0, 160) } : null;
  }
  const target = input.existing.find((instance) => instance.instanceId === proposed.instanceId);
  if (!target) return null;
  // Instance identity is kind-scoped. A host match against another kind means
  // the mention describes that instance rather than counting as one itself
  // (e.g. a value-labeled remark about a stored occurrence), so it settles as
  // REJECTED instead of leaving the mention unresolved.
  if (target.instanceKind !== input.mention.instanceKind) {
    return { decision: "REJECTED", reason: "cross_kind_reference" };
  }
  // The host resolver's judgment is identity only; whether that identity match
  // is a merge or a state transition is derived from the mention's grounded
  // state, mirroring the deterministic exact-identity path above.
  const state = input.mention.state;
  return state && state !== target.state && validState(target.instanceKind, state)
    ? { decision: "STATE_TRANSITION", instanceId: target.instanceId, state }
    : { decision: "SAME_AS", instanceId: target.instanceId };
}

export function stableInstanceId(profileId: string, mentionId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ profileId, mentionId }), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `instance:v1:${digest}`;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Map(values.filter((value): value is string => Boolean(value)).map((value) => [
    normalized(value),
    value,
  ])).values()].sort((left, right) => left.localeCompare(right));
}

function mergedAttributes(
  existing: MemoryInstanceAttributes,
  mention: MemoryInstanceAttributes,
  replace: boolean,
): MemoryInstanceAttributes {
  if (replace) return { ...existing, ...mention };
  return {
    ...(existing.entity ?? mention.entity ? { entity: existing.entity ?? mention.entity } : {}),
    ...(existing.target ?? mention.target ? { target: existing.target ?? mention.target } : {}),
    ...(existing.action ?? mention.action ? { action: existing.action ?? mention.action } : {}),
    ...(existing.quantity ?? mention.quantity ? { quantity: existing.quantity ?? mention.quantity } : {}),
    ...(existing.amount ?? mention.amount ? { amount: existing.amount ?? mention.amount } : {}),
    ...(existing.date ?? mention.date ? { date: existing.date ?? mention.date } : {}),
  };
}

export function reconcileCanonicalInstance(input: {
  mention: MemoryInstanceMention;
  decision: MemoryInstanceResolverDecision;
  existing?: MemoryCanonicalInstanceSnapshot | undefined;
  instanceId: string;
}): MemoryCanonicalInstanceSnapshot | null {
  if (input.decision.decision === "REJECTED") return null;
  const state = input.decision.decision === "STATE_TRANSITION"
    ? input.decision.state
    : defaultInstanceState(input.mention.instanceKind, input.mention.state);
  if (!state) return null;
  const replace = input.mention.instanceKind === "value" || input.decision.decision === "STATE_TRANSITION";
  return {
    instanceId: input.instanceId,
    instanceKind: input.mention.instanceKind,
    state,
    claim: input.existing && !replace ? input.existing.claim : input.mention.claim,
    attributes: mergedAttributes(input.existing?.attributes ?? {}, input.mention.attributes, replace),
    aliases: unique([
      ...(input.existing?.aliases ?? []),
      input.mention.attributes.entity,
      input.mention.attributes.target,
    ]),
    citations: unique([...(input.existing?.citations ?? []), input.mention.mentionId]),
    observedAt: input.existing && input.existing.observedAt > input.mention.observedAt
      ? input.existing.observedAt
      : input.mention.observedAt,
    ...(input.mention.occurredAt || input.existing?.occurredAt
      ? {
          occurredAt: replace
            ? input.mention.occurredAt ?? input.existing?.occurredAt
            : input.existing?.occurredAt ?? input.mention.occurredAt,
        }
      : {}),
  };
}

export function instanceCountsAsCurrent(instance: MemoryCanonicalInstanceSnapshot): boolean {
  return instance.state === ({
    object: "active",
    occurrence: "occurred",
    obligation: "pending",
    value: "current",
  } satisfies Record<MemoryInstanceKind, MemoryInstanceState>)[instance.instanceKind];
}
