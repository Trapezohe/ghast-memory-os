export function observedAtMetadata(createdAt: string | undefined): string {
  const raw = createdAt?.trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
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

function shiftedUtcDate(createdAt: string | undefined, dayOffset: number): Date | null {
  const raw = createdAt?.trim();
  if (!raw) return null;
  const calendarMatch = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/u.exec(raw);
  if (!calendarMatch || !dateFromCalendarValue(calendarMatch[1]!)) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const shifted = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate() + dayOffset));
  return shifted;
}

export function relativeEventDateMetadata(
  content: string,
  createdAt: string | undefined,
): Record<string, string> {
  const text = content.toLowerCase();
  const matches = [
    /\b(yesterday)\b/u.test(text) || /昨天/u.test(content) ? -1 : null,
    /\b(today)\b/u.test(text) || /今天/u.test(content) ? 0 : null,
    /\b(tomorrow)\b/u.test(text) || /明天/u.test(content) ? 1 : null,
  ].filter((value): value is number => value !== null);
  if (new Set(matches).size !== 1) return {};
  const dayOffset = matches[0]!;
  const date = shiftedUtcDate(createdAt, dayOffset);
  if (!date) return {};
  return {
    eventDate: calendarDate(date),
    relativeDateSource: dayOffset === -1 ? "yesterday" : dayOffset === 1 ? "tomorrow" : "today",
  };
}

export function relativeEventDateSegment(metadata: Record<string, unknown>): string {
  const eventDate = typeof metadata.eventDate === "string" ? metadata.eventDate.trim() : "";
  if (!eventDate) return "";
  const parsed = dateFromCalendarValue(eventDate);
  if (!parsed) return "";
  return `; event_date=${eventDate}; event_date_text=${calendarDateText(parsed)}`;
}

export function temporalMetadataSegment(
  createdAt: string | undefined,
  metadata: Record<string, unknown> = {},
): string {
  return `${observedAtSegment(createdAt)}${relativeEventDateSegment(metadata)}`;
}
