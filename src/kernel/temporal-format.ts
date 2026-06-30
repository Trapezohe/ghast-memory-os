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

export function relativeEventDateSegment(metadata: Record<string, unknown>): string {
  const eventDate = typeof metadata.eventDate === "string" ? metadata.eventDate.trim() : "";
  if (!eventDate) return "";
  const parsed = dateFromCalendarValue(eventDate);
  if (!parsed) return "";
  return `; event_date=${eventDate}; event_date_text=${calendarDateText(parsed)}`;
}

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

export function validityWindowSegment(metadata: Record<string, unknown>): string {
  const validFrom = validityInstantSegment("valid_from", metadata.validFrom ?? metadata.valid_from);
  const validTo = validityInstantSegment(
    "valid_to",
    metadata.validTo ?? metadata.valid_to ?? metadata.expiresAt,
  );
  return `${validFrom}${validTo}`;
}

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
