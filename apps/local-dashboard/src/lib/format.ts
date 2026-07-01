// Pure formatting helpers. No React, no side effects — trivially testable.

/** Format an ISO timestamp as a compact, locale-aware date-time. */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Human "time ago" for run/decision recency; falls back to a date. */
export function formatRelative(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) {
    return '—';
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return iso;
  }
  const deltaSec = Math.round((now - then) / 1000);
  const abs = Math.abs(deltaSec);
  if (abs < 45) {
    return 'just now';
  }
  const units: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const unit of units) {
    const [name, seconds] = unit;
    if (abs >= seconds) {
      return rtf.format(-Math.round(deltaSec / seconds), name);
    }
  }
  return 'just now';
}

/** Clamp a raw score into the inclusive 0–100 gauge range. */
export function clampScore(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Compact integer, e.g. 1_234 -> "1,234". */
export function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

/** Title-case a lowercase enum-ish token: "READY_WITH_WARNINGS" -> "Ready with warnings". */
export function humanize(token: string): string {
  const cleaned = token.replace(/[_-]+/g, ' ').trim().toLowerCase();
  if (cleaned.length === 0) {
    return token;
  }
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
