import { normalizeExplicitTemporalInstant } from "./temporal-validity.js";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function calendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function calendarDateText(date: Date): string {
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function dateFromCalendarValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month &&
    parsed.getUTCDate() === day
    ? parsed
    : null;
}

function dateFromCreatedAt(createdAt: string | undefined): Date | null {
  const raw = createdAt?.trim();
  if (!raw) return null;
  const calendarMatch = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/u.exec(raw);
  if (!calendarMatch || !dateFromCalendarValue(calendarMatch[1]!)) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizedInstantDateLabel(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const normalized = normalizeExplicitTemporalInstant(raw);
  if (!normalized) return "";
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return "";
  const date = calendarDate(parsed);
  const hours = parsed.getUTCHours();
  const minutes = parsed.getUTCMinutes();
  const seconds = parsed.getUTCSeconds();
  return hours === 0 && minutes === 0 && seconds === 0
    ? date
    : `${date} ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}${
        seconds === 0 ? "" : `:${String(seconds).padStart(2, "0")}`
      } UTC`;
}

// Keep emitted temporal annotation segments in sync with filterTemporalAnnotationSegments().
export function observedAtMetadata(createdAt: string | undefined): string {
  const parsed = dateFromCreatedAt(createdAt);
  if (!parsed) return "";
  const isoDate = parsed.toISOString().slice(0, 10);
  const hours = parsed.getUTCHours();
  const minutes = parsed.getUTCMinutes();
  const seconds = parsed.getUTCSeconds();
  const time =
    hours === 0 && minutes === 0 && seconds === 0
      ? ""
      : `; time=${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")} UTC`;
  return `observed=${isoDate}${time}`;
}

export function observedAtSegment(createdAt: string | undefined): string {
  const metadata = observedAtMetadata(createdAt);
  return metadata ? `; ${metadata}` : "";
}

export function observedAtLabel(createdAt: string | undefined): string {
  const parsed = dateFromCreatedAt(createdAt);
  return parsed ? `observed ${calendarDate(parsed)}` : "";
}

function shiftedUtcDate(createdAt: string | undefined, dayOffset: number): Date | null {
  const parsed = dateFromCreatedAt(createdAt);
  if (!parsed) return null;
  const shifted = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate() + dayOffset));
  return shifted;
}

export function eventDateMetadataFromTrustedOffset(
  createdAt: string | undefined,
  dayOffset: -1 | 0 | 1,
  source = "trusted_offset",
): Record<string, string> {
  const date = shiftedUtcDate(createdAt, dayOffset);
  if (!date) return {};
  return {
    eventDate: calendarDate(date),
    relativeDateSource: source,
  };
}

// Keep emitted temporal annotation segments in sync with filterTemporalAnnotationSegments().
export function relativeEventDateSegment(metadata: Record<string, unknown>): string {
  const eventDate = typeof metadata.eventDate === "string" ? metadata.eventDate.trim() : "";
  if (!eventDate) return "";
  const parsed = dateFromCalendarValue(eventDate);
  if (!parsed) return "";
  return `; event_date=${eventDate}; event_date_text=${calendarDateText(parsed)}`;
}

// Keep emitted temporal annotation segments in sync with filterTemporalAnnotationSegments().
export function eventTimeSegment(metadata: Record<string, unknown>): string {
  const eventTime = typeof metadata.eventTime === "string" ? metadata.eventTime.trim() : "";
  if (!eventTime) return "";
  const normalized = normalizeExplicitTemporalInstant(eventTime);
  if (!normalized) return "";
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return "";
  const eventDate = calendarDate(parsed);
  const hours = parsed.getUTCHours();
  const minutes = parsed.getUTCMinutes();
  const seconds = parsed.getUTCSeconds();
  const time =
    hours === 0 && minutes === 0 && seconds === 0
      ? ""
      : `; event_time_utc=${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}${
          seconds === 0 ? "" : `:${String(seconds).padStart(2, "0")}`
        }`;
  return `; event_time=${eventDate}; event_time_text=${calendarDateText(parsed)}${time}`;
}

function validityInstantSegment(label: "valid_from" | "valid_to", value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const normalized = normalizeExplicitTemporalInstant(raw);
  if (!normalized) return "";
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return "";
  const eventDate = calendarDate(parsed);
  const hours = parsed.getUTCHours();
  const minutes = parsed.getUTCMinutes();
  const seconds = parsed.getUTCSeconds();
  const time =
    hours === 0 && minutes === 0 && seconds === 0
      ? ""
      : `; ${label}_utc=${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}${
          seconds === 0 ? "" : `:${String(seconds).padStart(2, "0")}`
        }`;
  return `; ${label}=${eventDate}; ${label}_text=${calendarDateText(parsed)}${time}`;
}

// Keep emitted temporal annotation segments in sync with filterTemporalAnnotationSegments().
export function validityWindowSegment(metadata: Record<string, unknown>): string {
  const validFrom = validityInstantSegment("valid_from", metadata.validFrom ?? metadata.valid_from);
  const validTo = validityInstantSegment(
    "valid_to",
    metadata.validTo ?? metadata.valid_to ?? metadata.expiresAt,
  );
  return `${validFrom}${validTo}`;
}

export function temporalContextLabel(
  createdAt: string | undefined,
  metadata: Record<string, unknown> = {},
): string {
  const eventTime = normalizedInstantDateLabel(metadata.eventTime);
  if (eventTime) return eventTime;
  const eventDate = typeof metadata.eventDate === "string" ? metadata.eventDate.trim() : "";
  if (eventDate && dateFromCalendarValue(eventDate)) return eventDate;
  const validFrom = normalizedInstantDateLabel(metadata.validFrom ?? metadata.valid_from);
  const validTo = normalizedInstantDateLabel(metadata.validTo ?? metadata.valid_to ?? metadata.expiresAt);
  if (validFrom || validTo) return `${validFrom || ".."}..${validTo || ".."}`;
  return observedAtLabel(createdAt);
}

// Keep emitted temporal annotation segments in sync with filterTemporalAnnotationSegments().
export function temporalContextSegment(
  createdAt: string | undefined,
  metadata: Record<string, unknown> = {},
): string {
  const label = temporalContextLabel(createdAt, metadata);
  return label ? `; ${label}` : "";
}

const CALENDAR_SEGMENT = "\\d{4}-\\d{2}-\\d{2}";
const CLOCK_SEGMENT = "\\d{2}:\\d{2}(?::\\d{2})?";
const INSTANT_LABEL_SEGMENT = `${CALENDAR_SEGMENT}(?: ${CLOCK_SEGMENT} UTC)?`;
const INTERVAL_LABEL_SEGMENT = `(?:${INSTANT_LABEL_SEGMENT}|\\.\\.)\\.\\.(?:${INSTANT_LABEL_SEGMENT}|\\.\\.)`;
const MONTH_SEGMENT = MONTH_NAMES.join("|");

const TEMPORAL_ANNOTATION_SEGMENT_PATTERNS = [
  new RegExp(`^(?:observed\\s+)?${INSTANT_LABEL_SEGMENT}$`, "u"),
  new RegExp(`^${INTERVAL_LABEL_SEGMENT}$`, "u"),
  new RegExp(`^(?:observed|event_date|event_time|valid_from|valid_to)=${CALENDAR_SEGMENT}$`, "u"),
  new RegExp(`^time=${CLOCK_SEGMENT} UTC$`, "u"),
  new RegExp(`^(?:event_time_utc|valid_from_utc|valid_to_utc)=${CLOCK_SEGMENT}$`, "u"),
  new RegExp(
    `^(?:event_date_text|event_time_text|valid_from_text|valid_to_text)=\\d{1,2} (?:${MONTH_SEGMENT}) \\d{4}$`,
    "u",
  ),
];

export function filterTemporalAnnotationSegments(bracketContent: string): string[] {
  return bracketContent
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) =>
      segment.length > 0 &&
      TEMPORAL_ANNOTATION_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment))
    );
}

// Keep emitted temporal annotation segments in sync with filterTemporalAnnotationSegments().
export function temporalMetadataSegment(
  createdAt: string | undefined,
  metadata: Record<string, unknown> = {},
): string {
  return [
    observedAtSegment(createdAt),
    relativeEventDateSegment(metadata),
    eventTimeSegment(metadata),
    validityWindowSegment(metadata),
  ].join("");
}
