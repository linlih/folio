/** A device that has not synced for this long holds back compaction of the
 *  sync history (design/ARCHITECTURE.md §5.3). */
export const STALE_DAYS = 90;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export type Seen = { kind: "now" } | { kind: "today" } | { kind: "days"; days: number; stale: boolean };

/** When a device last synced, as the device list says it: just now, today,
 *  or so many calendar days ago (local time). */
export function seen(lastSeen: number, now: number): Seen {
  if (now - lastSeen < 2 * MINUTE) return { kind: "now" };
  const midnight = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((midnight(now) - midnight(lastSeen)) / DAY);
  if (days <= 0) return { kind: "today" };
  return { kind: "days", days, stale: now - lastSeen > STALE_DAYS * DAY };
}
