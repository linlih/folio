/** A device that has not synced for this long holds back compaction of the
 *  sync history (design/ARCHITECTURE.md §5.3). */
export const STALE_DAYS = 90;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The order the list shows: this device first, then the others in the
 *  order they joined. Not by last sync, which changes with every sync and
 *  would move a row under the finger. */
export function ordered<D extends { thisDevice: boolean; firstSeen: number; id: string }>(devices: D[]): D[] {
  return [...devices].sort(
    (a, b) => Number(b.thisDevice) - Number(a.thisDevice) || a.firstSeen - b.firstSeen || a.id.localeCompare(b.id),
  );
}

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
