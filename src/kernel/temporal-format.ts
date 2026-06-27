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
