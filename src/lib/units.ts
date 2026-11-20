/**
 * Stock units. Base units: weight = mg, volume = ml, piece = piece. All base quantities are integers.
 */
import { roundHalfUp } from "./money";

export type StockKind = "weight" | "volume" | "piece";

export const KIND_AR: Record<StockKind, string> = { weight: "وزن", volume: "حجم", piece: "قطعة" };

/** Base units per "big" display unit: 1 kg = 1,000,000 mg; 1 L = 1000 ml; 1 piece = 1. */
export function basePerBig(kind: StockKind): number {
  return kind === "weight" ? 1_000_000 : kind === "volume" ? 1000 : 1;
}

export function bigUnitLabel(kind: StockKind): string {
  return kind === "weight" ? "كغ" : kind === "volume" ? "لتر" : "قطعة";
}

export function smallUnitLabel(kind: StockKind): string {
  return kind === "weight" ? "غ" : kind === "volume" ? "مل" : "قطعة";
}

/** Base units per "small" display unit: 1 g = 1000 mg; 1 ml = 1 ml; 1 piece. */
export function basePerSmall(kind: StockKind): number {
  return kind === "weight" ? 1000 : 1;
}

function parseDecimal(input: string | number): number {
  const s = String(input).trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`رقم غير صالح: ${input}`);
  return Number(s);
}

/** User enters a quantity in kg / L / pieces → integer base units (round half up). */
export function bigToBase(kind: StockKind, input: string | number): number {
  const v = parseDecimal(input);
  if (kind === "piece" && !Number.isInteger(v)) throw new Error("عدد القطع يجب أن يكون عدداً صحيحاً");
  return roundHalfUp(v * basePerBig(kind));
}

export function smallToBase(kind: StockKind, input: string | number): number {
  const v = parseDecimal(input);
  return roundHalfUp(v * basePerSmall(kind));
}

/** Display base units as "2.350 كغ" / "1.500 لتر" / "24 قطعة". */
export function formatQty(kind: StockKind, base: number | string): string {
  const b = Number(base);
  if (kind === "piece") return `${b} ${bigUnitLabel(kind)}`;
  const v = b / basePerBig(kind);
  return `${v.toFixed(3)} ${bigUnitLabel(kind)}`;
}

export function formatSmall(kind: StockKind, base: number | string): string {
  const b = Number(base);
  if (kind === "piece") return `${roundHalfUp(b, 3)} قطعة`;
  return `${roundHalfUp(b / basePerSmall(kind), 3)} ${smallUnitLabel(kind)}`;
}

/**
 * "Units per kg/L" yield → base quantity per unit.
 *  nominal (accounted) yield → integer base (deducted from stock), real yield → 3-decimal real consumption.
 *  e.g. coffee 80/kg → 12500 mg ; real 90/kg → 11111.111 mg ; jirak 15/kg → 66667 mg.
 */
export function yieldToNominalBase(kind: StockKind, unitsPerBig: number): number {
  if (!(unitsPerBig > 0)) throw new Error("الإنتاج يجب أن يكون أكبر من صفر");
  return roundHalfUp(basePerBig(kind) / unitsPerBig);
}

export function yieldToRealBase(kind: StockKind, unitsPerBig: number): number {
  if (!(unitsPerBig > 0)) throw new Error("الإنتاج يجب أن يكون أكبر من صفر");
  return roundHalfUp(basePerBig(kind) / unitsPerBig, 3);
}

export function baseToYield(kind: StockKind, base: number): number {
  return base > 0 ? roundHalfUp(basePerBig(kind) / base, 2) : 0;
}
