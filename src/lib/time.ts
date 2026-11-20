/**
 * Time helpers — always the IANA zone Africa/Tunis, never a fixed offset (spec §2, §7.1, §15).
 */
export const TZ = "Africa/Tunis";

export type Shift = "morning" | "evening";

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function tunisParts(d: Date): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second),
  };
}

/** 'YYYY-MM-DD' arithmetic on calendar dates (no time zone involved). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function ymd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Spec §7.1 — business day & shift are pure functions of the timestamp. */
export function shiftInfo(ts: Date, morningStart = 6, eveningStart = 15): { businessDay: string; shift: Shift } {
  const p = tunisParts(ts);
  let day = ymd(p.year, p.month, p.day);
  if (p.hour < morningStart) day = addDays(day, -1);
  const shift: Shift = p.hour >= morningStart && p.hour < eveningStart ? "morning" : "evening";
  return { businessDay: day, shift };
}

/** Convert a Tunis wall-clock time to a UTC Date (handles any future DST via the IANA zone). */
export function tunisLocalToUtc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const p = tunisParts(new Date(t));
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = asUtc - guess;
    if (diff === 0) break;
    t -= diff;
  }
  return new Date(t);
}

/** Parse an <input type="datetime-local"> value ("2026-11-20T15:00") interpreted in Tunis time. */
export function parseTunisLocal(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) throw new Error("تاريخ/وقت غير صالح");
  return tunisLocalToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

export function toTunisLocalInput(d: Date): string {
  const p = tunisParts(d);
  return `${ymd(p.year, p.month, p.day)}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function formatTunis(d: Date | string | null | undefined, withSeconds = false): string {
  if (!d) return "—";
  const p = tunisParts(new Date(d));
  const hm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}${withSeconds ? ":" + String(p.second).padStart(2, "0") : ""}`;
  return `${ymd(p.year, p.month, p.day)} ${hm}`;
}

/** Start instant (UTC) of a business day / shift. */
export function shiftStart(businessDay: string, shift: Shift, morningStart = 6, eveningStart = 15): Date {
  const [y, m, d] = businessDay.split("-").map(Number);
  return tunisLocalToUtc(y, m, d, shift === "morning" ? morningStart : eveningStart);
}

export function shiftEnd(businessDay: string, shift: Shift, morningStart = 6, eveningStart = 15): Date {
  if (shift === "morning") return shiftStart(businessDay, "evening", morningStart, eveningStart);
  return shiftStart(addDays(businessDay, 1), "morning", morningStart, eveningStart);
}

export function daysInMonth(day: string): number {
  const [y, m] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Monday-based week start for a business day (spec: week Monday → Sunday). */
export function weekStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const offset = (dow + 6) % 7;
  return addDays(day, -offset);
}

export function monthStart(day: string): string {
  return day.slice(0, 8) + "01";
}

export function monthEnd(day: string): string {
  return day.slice(0, 8) + String(daysInMonth(day)).padStart(2, "0");
}

export const SHIFT_AR: Record<Shift, string> = { morning: "صباحية", evening: "مسائية" };
