// Document and block ids, matching crates/folio-core/src/ids.rs.

/** UUIDv7: 48-bit millisecond timestamp, version and variant bits, random rest. */
export function uuidv7(now: number = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let t = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const newBid = () => uuidv7();

/** A local calendar date as `YYYY-MM-DD` (§5.2a: the device's time zone decides). */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const journalId = (date: string) => `journal:${date}`;
export const isJournalId = (id: string) => id.startsWith("journal:");
export const journalDate = (id: string) => id.slice("journal:".length);

/** The date `days` before `date` (`YYYY-MM-DD`), in local time. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + days));
}
