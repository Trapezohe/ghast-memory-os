const DATE_VALUE =
  String.raw`\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2}))?`;
const DATE_OR_INSTANT = `${DATE_VALUE}(?![\\p{L}\\p{N}_-])`;
const DATE_OR_INSTANT_BEFORE_HAN = `${DATE_VALUE}(?=\\p{Script=Han}|[,.，。:：;；]|\\s|$)`;
const MONTH_NAME =
  String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const ORDINAL_DAY = String.raw`\d{1,2}(?:st|nd|rd|th)?`;
const NATURAL_DATE_VALUE = String.raw`(?:${MONTH_NAME}\s+${ORDINAL_DAY},?\s+\d{4}|${ORDINAL_DAY}\s+${MONTH_NAME},?\s+\d{4})`;
const HAN_DATE_VALUE = String.raw`\d{4}年\d{1,2}月\d{1,2}日?`;
const DATE_TEXT_RIGHT_BOUNDARY = String.raw`(?=\p{Script=Han}|[^\p{L}\p{N}_-]|$)`;
const HAN_DATE_IN_TEXT = String.raw`\d{4}年\d{1,2}月\d{1,2}(?:日${DATE_TEXT_RIGHT_BOUNDARY}|(?!日)${DATE_TEXT_RIGHT_BOUNDARY})`;
const ENGLISH_EVENT_TIME_VALUE = String.raw`(?:${DATE_OR_INSTANT}|${NATURAL_DATE_VALUE})`;
const HAN_EVENT_TIME_VALUE = String.raw`(?:${DATE_OR_INSTANT_BEFORE_HAN}|${HAN_DATE_IN_TEXT})`;
const DATE_OR_INSTANT_IN_TEXT = `${DATE_VALUE}${DATE_TEXT_RIGHT_BOUNDARY}`;
const NATURAL_DATE_IN_TEXT = `${NATURAL_DATE_VALUE}(?![\\p{L}\\p{N}_-])`;
const ENGLISH_VALIDITY_TIME_VALUE = String.raw`(?:${DATE_OR_INSTANT}|${NATURAL_DATE_IN_TEXT})`;
const HAN_VALIDITY_TIME_VALUE = String.raw`(?:${DATE_OR_INSTANT_BEFORE_HAN}|${HAN_DATE_IN_TEXT})`;

const MONTH_ALIASES: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

interface CalendarParts {
  year: number;
  month: number;
  day: number;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isoDateParts(value: string): CalendarParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/u.exec(value);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function monthNumber(value: string): number | null {
  return MONTH_ALIASES[value.toLowerCase().replace(/\.$/u, "")] ?? null;
}

function dayNumber(value: string): number {
  return Number(value.replace(/(?:st|nd|rd|th)$/iu, ""));
}

function englishDateParts(value: string): CalendarParts | null {
  const normalized = value.trim().replace(/\s+/gu, " ");
  const monthFirst = new RegExp(
    String.raw`^(${MONTH_NAME})\s+(${ORDINAL_DAY}),?\s+(\d{4})$`,
    "iu",
  ).exec(normalized);
  if (monthFirst) {
    const month = monthNumber(monthFirst[1]!);
    if (!month) return null;
    return {
      year: Number(monthFirst[3]),
      month,
      day: dayNumber(monthFirst[2]!),
    };
  }
  const dayFirst = new RegExp(
    String.raw`^(${ORDINAL_DAY})\s+(${MONTH_NAME}),?\s+(\d{4})$`,
    "iu",
  ).exec(normalized);
  if (!dayFirst) return null;
  const month = monthNumber(dayFirst[2]!);
  if (!month) return null;
  return {
    year: Number(dayFirst[3]),
    month,
    day: dayNumber(dayFirst[1]!),
  };
}

function hanDateParts(value: string): CalendarParts | null {
  const match = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/u.exec(value.trim());
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function calendarInstant(parts: CalendarParts): string | null {
  if (!isValidCalendarDate(parts.year, parts.month, parts.day)) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).toISOString();
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function addTemporalCueValues(values: string[], value: string): void {
  const normalized = normalizeExplicitTemporalInstant(value);
  if (!normalized) return;
  values.push(normalized, normalized.slice(0, 10));
}

function hasDateTextLeftBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;
  const previous = Array.from(text.slice(0, index)).at(-1);
  return !previous || !/[\p{Script=Latin}\p{N}_-]/u.test(previous);
}

export function normalizeExplicitTemporalInstant(value: string): string | null {
  const trimmed = value.trim();
  const parts = isoDateParts(trimmed);
  const naturalParts = parts ? null : englishDateParts(trimmed) ?? hanDateParts(trimmed);
  if (naturalParts) return calendarInstant(naturalParts);
  if (!parts || !isValidCalendarDate(parts.year, parts.month, parts.day)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).toISOString();
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/u.test(trimmed)) return null;
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

export function temporalCueValuesFromText(text: string): string[] {
  const values: string[] = [];
  const patterns = [
    new RegExp(DATE_OR_INSTANT_IN_TEXT, "giu"),
    new RegExp(String.raw`\b${NATURAL_DATE_VALUE}\b`, "giu"),
    new RegExp(HAN_DATE_IN_TEXT, "gu"),
  ];
  for (const [patternIndex, pattern] of patterns.entries()) {
    for (const match of text.matchAll(pattern)) {
      if (patternIndex === 0 && !hasDateTextLeftBoundary(text, match.index ?? 0)) continue;
      addTemporalCueValues(values, match[0]);
    }
  }
  return uniqueValues(values);
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1];
    if (!value) continue;
    const normalized = normalizeExplicitTemporalInstant(value);
    if (normalized) return normalized;
  }
  return null;
}

function explicitValidityRangeMetadata(content: string): { matched: boolean; metadata: Record<string, string> } {
  const patterns = [
    new RegExp(
      String.raw`\b(?:valid|active|effective)\s+from\s+(${ENGLISH_VALIDITY_TIME_VALUE})\s+(?:to|until|through)\s+(${ENGLISH_VALIDITY_TIME_VALUE})`,
      "iu",
    ),
    new RegExp(
      String.raw`(?:从|自)\s*(${HAN_VALIDITY_TIME_VALUE})\s*(?:开始|起)?\s*(?:到|至|直到|截止(?:到)?)\s*(${HAN_VALIDITY_TIME_VALUE})`,
      "u",
    ),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    const rawFrom = match?.[1];
    const rawTo = match?.[2];
    if (!rawFrom || !rawTo) continue;
    const validFrom = normalizeExplicitTemporalInstant(rawFrom);
    const validTo = normalizeExplicitTemporalInstant(rawTo);
    return {
      matched: true,
      metadata: validFrom && validTo ? { validFrom, validTo } : {},
    };
  }
  return { matched: looksLikeExplicitValidityRange(content), metadata: {} };
}

function looksLikeExplicitValidityRange(content: string): boolean {
  const englishDateLike = String.raw`(?:\d{4}-\d{1,2}-\d{1,2}(?:T[^\s,.;，。:：;；]*)?|${MONTH_NAME}\s+${ORDINAL_DAY},?\s+\d{4}\S*|${ORDINAL_DAY}\s+${MONTH_NAME},?\s+\d{4}\S*)`;
  const hanDateLike = String.raw`\d{4}年\d{1,2}月\d{1,2}日?\S*`;
  return (
    new RegExp(
      String.raw`\b(?:valid|active|effective)\s+from\s+${englishDateLike}\s+(?:to|until|through)\s+${englishDateLike}`,
      "iu",
    ).test(content) ||
    new RegExp(
      String.raw`(?:从|自)\s*${hanDateLike}\s*(?:开始|起)?\s*(?:到|至|直到|截止(?:到)?)\s*${hanDateLike}`,
      "u",
    ).test(content)
  );
}

function hasAny(metadata: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => typeof metadata[key] === "string" && String(metadata[key]).trim());
}

function explicitEventTimeContextIsValidity(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 36), index).trimEnd();
  return (
    /\b(?:valid|active|effective|expires?|expired|expiration(?:\s+date)?|until|through|validity)(?:\s+(?:is|was))?$/iu.test(
      before,
    ) || /(?:有效|到期|截止|直到)\s*$/u.test(before)
  );
}

export function explicitEventTimeMetadata(content: string): Record<string, string> {
  const patterns = [
    new RegExp(String.raw`\b(?:on|at)\s+(${ENGLISH_EVENT_TIME_VALUE})(?:[,.，。:：;；]|\s|$)`, "iu"),
    new RegExp(String.raw`(?:在|于)\s*(${HAN_EVENT_TIME_VALUE})(?=\p{Script=Han}|[,.，。:：;；]|\s|$)`, "u"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    const value = match?.[1];
    if (!value || explicitEventTimeContextIsValidity(content, match.index)) continue;
    const eventTime = normalizeExplicitTemporalInstant(value);
    if (eventTime) return { eventTime };
  }
  return {};
}

export function explicitTemporalValidityMetadata(content: string): Record<string, string> {
  const range = explicitValidityRangeMetadata(content);
  if (range.matched) return range.metadata;
  const fromPatterns = [
    new RegExp(String.raw`\b(?:valid|active|effective)\s+from\s+(${ENGLISH_VALIDITY_TIME_VALUE})`, "iu"),
    new RegExp(String.raw`\b(?:starting|starts)\s+(?:on\s+)?(${ENGLISH_VALIDITY_TIME_VALUE})`, "iu"),
    new RegExp(String.raw`(?:从|自)\s*(${HAN_VALIDITY_TIME_VALUE})\s*(?:开始|起)`, "u"),
  ];
  const toPatterns = [
    new RegExp(
      String.raw`\b(?:valid|active|effective)\s+from\s+${ENGLISH_VALIDITY_TIME_VALUE}\s+(?:to|until|through)\s+(${ENGLISH_VALIDITY_TIME_VALUE})`,
      "iu",
    ),
    new RegExp(
      String.raw`\b(?:valid|active|effective)\s+(?:to|until|through)\s+(${ENGLISH_VALIDITY_TIME_VALUE})`,
      "iu",
    ),
    new RegExp(String.raw`\buntil\s+(${ENGLISH_VALIDITY_TIME_VALUE})`, "iu"),
    new RegExp(
      String.raw`\b(?:expires?|expired|expiration(?:\s+date)?)(?:\s+(?:is|was|on|at))?\s+(${ENGLISH_VALIDITY_TIME_VALUE})`,
      "iu",
    ),
    new RegExp(String.raw`(?:有效期到|到期(?:于)?|截止(?:到)?|直到)\s*(${HAN_VALIDITY_TIME_VALUE})`, "u"),
    new RegExp(String.raw`到\s*(${HAN_VALIDITY_TIME_VALUE})\s*(?:为止|截止)`, "u"),
  ];
  const validFrom = firstMatch(content, fromPatterns);
  const validTo = firstMatch(content, toPatterns);
  return {
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
  };
}

export function mergeExplicitTemporalValidityMetadata(
  content: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const inferred = explicitTemporalValidityMetadata(content);
  const merged = { ...metadata };
  let added = false;
  if (inferred.validFrom && !hasAny(merged, ["validFrom", "valid_from"])) {
    merged.validFrom = inferred.validFrom;
    added = true;
  }
  if (inferred.validTo && !hasAny(merged, ["validTo", "valid_to", "expiresAt"])) {
    merged.validTo = inferred.validTo;
    added = true;
  }
  if (added && !hasAny(merged, ["temporalValiditySource"])) {
    merged.temporalValiditySource = "explicit_text";
  }
  return merged;
}
