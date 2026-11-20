import { describe, expect, it } from "vitest";
import { addDays, daysInMonth, shiftInfo, tunisLocalToUtc, weekStart } from "@/lib/time";
import { formatDT, parseDT, roundHalfUp } from "@/lib/money";
import { bigToBase, yieldToNominalBase, yieldToRealBase } from "@/lib/units";
import { canonicalJson, extractTicketToken, normaliseShortCode } from "@/lib/canonical";
import { marginAnalysis } from "@/server/stock";
import { prorateFixed } from "@/server/finance";
import { totpAt, verifyTotp, base32Encode } from "@/server/crypto";

const at = (y: number, m: number, d: number, h: number, mi = 0) => tunisLocalToUtc(y, m, d, h, mi);

describe("1. shift / business day boundaries (§7.1)", () => {
  it("handles the documented boundaries", () => {
    expect(shiftInfo(at(2026, 3, 10, 5, 59))).toEqual({ businessDay: "2026-03-09", shift: "evening" });
    expect(shiftInfo(at(2026, 3, 10, 6, 0))).toEqual({ businessDay: "2026-03-10", shift: "morning" });
    expect(shiftInfo(at(2026, 3, 10, 14, 59))).toEqual({ businessDay: "2026-03-10", shift: "morning" });
    expect(shiftInfo(at(2026, 3, 10, 15, 0))).toEqual({ businessDay: "2026-03-10", shift: "evening" });
    expect(shiftInfo(at(2026, 3, 10, 23, 59))).toEqual({ businessDay: "2026-03-10", shift: "evening" });
    expect(shiftInfo(at(2026, 3, 11, 0, 30))).toEqual({ businessDay: "2026-03-10", shift: "evening" });
  });
  it("rolls over months and years", () => {
    expect(shiftInfo(at(2026, 3, 1, 2, 0))).toEqual({ businessDay: "2026-02-28", shift: "evening" });
    expect(shiftInfo(at(2028, 3, 1, 2, 0))).toEqual({ businessDay: "2028-02-29", shift: "evening" });
    expect(shiftInfo(at(2027, 1, 1, 3, 0))).toEqual({ businessDay: "2026-12-31", shift: "evening" });
  });
  it("uses Africa/Tunis, not UTC (02:00 Tue Tunis = 01:00 UTC → Monday)", () => {
    const d = new Date("2026-11-17T01:00:00Z"); // Tue 02:00 in Tunis
    expect(shiftInfo(d)).toEqual({ businessDay: "2026-11-16", shift: "evening" });
  });
  it("respects configurable hours", () => {
    expect(shiftInfo(at(2026, 3, 10, 6, 30), 7, 16)).toEqual({ businessDay: "2026-03-09", shift: "evening" });
    expect(shiftInfo(at(2026, 3, 10, 15, 30), 7, 16)).toEqual({ businessDay: "2026-03-10", shift: "morning" });
  });
  it("week starts Monday", () => {
    expect(weekStart("2026-11-20")).toBe("2026-11-16"); // Friday → Monday
    expect(weekStart("2026-11-16")).toBe("2026-11-16");
    expect(weekStart("2026-11-22")).toBe("2026-11-16"); // Sunday
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("2. integer money & stock arithmetic", () => {
  it("80 coffees deduct exactly 1,000,000 mg", () => {
    const perCup = yieldToNominalBase("weight", 80);
    expect(perCup).toBe(12500);
    expect(perCup * 80).toBe(1_000_000);
  });
  it("jirak 15/kg accounted → 66667 mg, real 16/kg → 62500 mg", () => {
    expect(yieldToNominalBase("weight", 15)).toBe(66667);
    expect(yieldToRealBase("weight", 16)).toBe(62500);
    expect(yieldToRealBase("weight", 90)).toBe(11111.111);
  });
  it("parses and formats DT without float drift", () => {
    expect(parseDT("1.800")).toBe(1800);
    expect(parseDT("1,8")).toBe(1800);
    expect(parseDT("0.1")).toBe(100);
    expect(parseDT("12")).toBe(12000);
    expect(() => parseDT("1.2345")).toThrow();
    expect(formatDT(1800)).toBe("1.800 DT");
    expect(formatDT(-50)).toBe("-0.050 DT");
    expect(formatDT(1234567)).toBe("1 234.567 DT");
    let sum = 0; for (let i = 0; i < 1000; i++) sum += parseDT("0.1");
    expect(sum).toBe(100_000);
  });
  it("rounds half up once", () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(1.0005, 3)).toBe(1.001);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(bigToBase("weight", "1.25")).toBe(1_250_000);
    expect(() => bigToBase("piece", "1.5")).toThrow();
  });
});

describe("3. margin analysis formulas (§7.4)", () => {
  // 80 cups sold: expected surplus = 80 × (12500 − 11111.111) = 111111.12 mg
  const expected = 80 * (12500 - 11111.111);
  it("honest: variance ≈ expected surplus → 0% used", () => {
    expect(marginAnalysis(Math.round(expected), expected, 0.04).marginUsedPct).toBeCloseTo(0, 1);
  });
  it("zero variance → 100% used", () => {
    expect(marginAnalysis(0, expected, 0.04).marginUsedPct).toBe(100);
  });
  it("negative variance → > 100% and negative value", () => {
    const r = marginAnalysis(-50_000, expected, 0.04);
    expect(r.marginUsedPct).toBeGreaterThan(100);
    expect(r.value).toBe(-2000); // 50 g × 0.04 millimes/mg = 2.000 DT
  });
  it("no expected surplus (piece) → no percentage", () => {
    expect(marginAnalysis(-1, 0, 500).marginUsedPct).toBeNull();
  });
});

describe("9. fixed-cost proration per calendar month", () => {
  const rent = [{ amountMillimes: 600_000, startDay: "2026-01-01", endDay: null }];
  it("one full month = full amount (28/30/31 days)", () => {
    expect(prorateFixed(rent, "2026-02-01", "2026-02-28")).toBe(600_000);
    expect(prorateFixed(rent, "2026-04-01", "2026-04-30")).toBe(600_000);
    expect(prorateFixed(rent, "2026-01-01", "2026-01-31")).toBe(600_000);
    expect(daysInMonth("2028-02-10")).toBe(29);
  });
  it("one day uses that month's length", () => {
    expect(prorateFixed(rent, "2026-02-10", "2026-02-10")).toBe(21429); // 600000/28
    expect(prorateFixed(rent, "2026-01-10", "2026-01-10")).toBe(19355); // 600000/31
  });
  it("respects start / end", () => {
    expect(prorateFixed([{ amountMillimes: 300_000, startDay: "2026-04-16", endDay: "2026-04-20" }], "2026-04-01", "2026-04-30")).toBe(50_000);
  });
});

describe("canonical JSON & helpers", () => {
  it("sorts keys deterministically", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
  });
  it("extracts tokens and normalises short codes", () => {
    expect(extractTicketToken("https://x.tn/t/abc_DEF-1")).toBe("abc_DEF-1");
    expect(extractTicketToken(" abc ")).toBe("abc");
    expect(normaliseShortCode(" ab-cd o1l ")).toBe("ABCD011");
  });
});

describe("8. TOTP (RFC 6238)", () => {
  it("matches the RFC test vector", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpAt(secret, 59_000)).toBe("287082");
    expect(totpAt(secret, 1111111109_000)).toBe("081804");
    expect(verifyTotp(secret, "081804", 1111111109_000)).toBe(true);
    expect(verifyTotp(secret, "000000", 1111111109_000)).toBe(false);
  });
});
