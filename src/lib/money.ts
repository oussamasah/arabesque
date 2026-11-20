/**
 * Money helpers. 1 DT = 1000 millimes. Money is always an integer number of millimes.
 * Derived costs may carry 3 decimals of a millime (numeric(18,3)) and are rounded explicitly.
 */

/** Round half up (away from zero for positives, toward +inf for .5 on negatives like SQL round half up on abs). */
export function roundHalfUp(x: number, decimals = 0): number {
  const f = 10 ** decimals;
  const v = Math.abs(x) * f;
  // guard against binary artefacts like 1.0049999999 -> use a tiny epsilon relative to magnitude
  const r = Math.floor(v + 0.5 + 1e-9 * Math.max(1, v));
  return (Math.sign(x) || 1) * (r / f);
}

export function assertInt(n: number, what = "value"): number {
  if (!Number.isSafeInteger(n)) throw new Error(`${what} must be an integer (got ${n})`);
  return n;
}

/** Parse a user-entered DT amount ("1.800", "1,8", "12") into millimes. Throws on invalid. */
export function parseDT(input: string | number | null | undefined): number {
  if (input === null || input === undefined) throw new Error("المبلغ مطلوب");
  const s = String(input).trim().replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d{0,3})?$/.test(s)) throw new Error(`مبلغ غير صالح: ${input}`);
  const neg = s.startsWith("-");
  const [ip, fp = ""] = s.replace("-", "").split(".");
  const millimes = Number(ip) * 1000 + Number((fp + "000").slice(0, 3));
  return assertInt(neg ? -millimes : millimes, "amount");
}

/** Format millimes as "1.800 DT". Accepts fractional millimes (costs) and rounds to an integer millime for display. */
export function formatDT(millimes: number | string | null | undefined, withUnit = true): string {
  if (millimes === null || millimes === undefined || millimes === "") return "—";
  const m = roundHalfUp(Number(millimes));
  const neg = m < 0;
  const abs = Math.abs(m);
  const dt = Math.floor(abs / 1000);
  const mm = String(abs % 1000).padStart(3, "0");
  const intPart = String(dt).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${neg ? "-" : ""}${intPart}.${mm}${withUnit ? " DT" : ""}`;
}

/** Millimes -> "1.800" for form default values. */
export function millimesToInput(m: number | null | undefined): string {
  if (m === null || m === undefined) return "";
  const neg = m < 0;
  const a = Math.abs(m);
  return `${neg ? "-" : ""}${Math.floor(a / 1000)}.${String(a % 1000).padStart(3, "0")}`;
}
