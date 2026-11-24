import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { workerAdvances, workerDays, workers, wagePayments } from "@/db/schema";
import type { Exec } from "@/db";
import { audit } from "./audit";
import { getSettings } from "./settings";
import { assertInt } from "@/lib/money";
import { addDays, eachDay, shiftInfo, weekStart } from "@/lib/time";

export type Worker = typeof workers.$inferSelect;

export async function todayDay(db: Exec): Promise<string> {
  const s = await getSettings(db);
  return shiftInfo(new Date(), s.morning_start_hour, s.evening_start_hour).businessDay;
}

export async function addWorker(db: Exec, nameAr: string, wage: number, startDay: string, actor: string) {
  if (!nameAr.trim()) throw new Error("الاسم مطلوب");
  assertInt(wage, "wage");
  if (wage <= 0) throw new Error("الأجر اليومي يجب أن يكون أكبر من صفر");
  const [row] = await db.insert(workers).values({ nameAr: nameAr.trim(), dailyWageMillimes: wage, startDay }).returning();
  await audit(db, actor, "worker.create", "worker", row.id, null, row);
  return row;
}

/** Past days with no record are written down with the CURRENT wage, so a wage change never rewrites the past. */
async function freezePast(db: Exec, w: Worker, today: string) {
  const last = addDays(today, -1);
  const to = w.endDay && w.endDay < last ? w.endDay : last;
  if (to < w.startDay) return;
  const rec = await db.select().from(workerDays).where(and(eq(workerDays.workerId, w.id), gte(workerDays.day, w.startDay), lte(workerDays.day, to)));
  const have = new Set(rec.map((r) => r.day));
  const rows = eachDay(w.startDay, to).filter((d) => !have.has(d)).map((d) => ({ workerId: w.id, day: d, halves: 2, wageMillimes: w.dailyWageMillimes }));
  if (rows.length) await db.insert(workerDays).values(rows);
}

export async function updateWorker(db: Exec, id: number, input: { nameAr: string; wage: number; endDay: string | null }, actor: string) {
  const [before] = await db.select().from(workers).where(eq(workers.id, id));
  if (!before) throw new Error("عامل غير موجود");
  assertInt(input.wage, "wage");
  if (input.wage <= 0) throw new Error("الأجر اليومي يجب أن يكون أكبر من صفر");
  const today = await todayDay(db);
  if (input.wage !== before.dailyWageMillimes) await freezePast(db, before, today);
  const [row] = await db.update(workers).set({ nameAr: input.nameAr.trim() || before.nameAr, dailyWageMillimes: input.wage, endDay: input.endDay }).where(eq(workers.id, id)).returning();
  await audit(db, actor, "worker.update", "worker", id, before, row);
  return row;
}

/** Attendance of a week: halves per worker/day (0 absent, 1 half, 2 full). Stores the wage of that day. */
export async function setAttendance(db: Exec, entries: { workerId: number; day: string; halves: number }[], actor: string) {
  for (const e of entries) {
    if (![0, 1, 2].includes(e.halves)) throw new Error("قيمة الحضور غير صالحة");
    const [w] = await db.select().from(workers).where(eq(workers.id, e.workerId));
    if (!w) throw new Error("عامل غير موجود");
    const [ex] = await db.select().from(workerDays).where(and(eq(workerDays.workerId, e.workerId), eq(workerDays.day, e.day)));
    if (ex) {
      if (ex.halves !== e.halves) await db.update(workerDays).set({ halves: e.halves }).where(eq(workerDays.id, ex.id));
    } else if (e.halves !== 2) {
      await db.insert(workerDays).values({ workerId: e.workerId, day: e.day, halves: e.halves, wageMillimes: w.dailyWageMillimes });
    }
  }
  await audit(db, actor, "wages.attendance", "worker_days", entries[0]?.day ?? "-", null, { changed: entries.length });
}

export async function addAdvance(db: Exec, workerId: number, amount: number, ts: Date, note: string | null, actor: string) {
  assertInt(amount, "amount");
  if (amount <= 0) throw new Error("المبلغ يجب أن يكون أكبر من صفر");
  const [w] = await db.select().from(workers).where(eq(workers.id, workerId));
  if (!w) throw new Error("عامل غير موجود");
  const s = await getSettings(db);
  const [row] = await db.insert(workerAdvances).values({
    workerId, ts, businessDay: shiftInfo(ts, s.morning_start_hour, s.evening_start_hour).businessDay, amountMillimes: amount, note, createdBy: actor,
  }).returning();
  await audit(db, actor, "wages.advance", "worker", workerId, null, row);
  return row;
}

export async function cancelAdvance(db: Exec, id: number, actor: string) {
  const [row] = await db.update(workerAdvances).set({ cancelledAt: new Date() }).where(and(eq(workerAdvances.id, id), isNull(workerAdvances.cancelledAt))).returning();
  if (!row) throw new Error("تسبقة غير موجودة أو ملغاة");
  await audit(db, actor, "wages.advance_cancel", "worker", row.workerId, row, null);
}

export async function payWage(db: Exec, workerId: number, amount: number, week: string, ts: Date, note: string | null, actor: string) {
  assertInt(amount, "amount");
  if (amount <= 0) throw new Error("المبلغ يجب أن يكون أكبر من صفر");
  const [w] = await db.select().from(workers).where(eq(workers.id, workerId));
  if (!w) throw new Error("عامل غير موجود");
  const [row] = await db.insert(wagePayments).values({ workerId, ts, weekStart: weekStart(week), amountMillimes: amount, note, createdBy: actor }).returning();
  await audit(db, actor, "wages.pay", "worker", workerId, null, row);
  return row;
}

export async function cancelPayment(db: Exec, id: number, actor: string) {
  const [row] = await db.update(wagePayments).set({ cancelledAt: new Date() }).where(and(eq(wagePayments.id, id), isNull(wagePayments.cancelledAt))).returning();
  if (!row) throw new Error("دفعة غير موجودة أو ملغاة");
  await audit(db, actor, "wages.pay_cancel", "worker", row.workerId, row, null);
}

type Rec = Map<string, { halves: number; wage: number }>;

/** Wage earned by a worker between two days (inclusive), never beyond today / the end day. Unrecorded days = a full day at the current wage. */
function earnedIn(w: Worker, rec: Rec, from: string, to: string, today: string): number {
  const a = from < w.startDay ? w.startDay : from;
  let b = to > today ? today : to;
  if (w.endDay && b > w.endDay) b = w.endDay;
  if (b < a) return 0;
  let sum = 0;
  for (const d of eachDay(a, b)) {
    const r = rec.get(w.id + "|" + d);
    sum += r ? Math.round((r.halves * r.wage) / 2) : w.dailyWageMillimes;
  }
  return sum;
}

async function recMap(db: Exec, from: string, to: string): Promise<Rec> {
  const rows = await db.select().from(workerDays).where(and(gte(workerDays.day, from), lte(workerDays.day, to)));
  return new Map(rows.map((r) => [r.workerId + "|" + r.day, { halves: r.halves, wage: r.wageMillimes }]));
}

/** Total wages earned in a period (an expense of the period, by day worked). */
export async function wagesInRange(db: Exec, from: string, to: string): Promise<number> {
  const ws = await db.select().from(workers);
  if (!ws.length) return 0;
  const today = await todayDay(db);
  const rec = await recMap(db, from, to);
  return ws.reduce((a, w) => a + earnedIn(w, rec, from, to, today), 0);
}

export interface WageRow {
  worker: Worker;
  days: { day: string; halves: number; counted: boolean }[];
  earned: number; advances: number; paid: number; carry: number; remaining: number;
}

export async function weekReport(db: Exec, ws: string) {
  const today = await todayDay(db);
  const we = addDays(ws, 6);
  const all = await db.select().from(workers).orderBy(asc(workers.id));
  const rec = await recMap(db, "2000-01-01", we);
  const adv = await db.select().from(workerAdvances).where(and(isNull(workerAdvances.cancelledAt), lte(workerAdvances.businessDay, we)));
  const pay = await db.select().from(wagePayments).where(and(isNull(wagePayments.cancelledAt), lte(wagePayments.weekStart, we)));
  const rows: WageRow[] = [];
  for (const w of all) {
    const carryEarned = earnedIn(w, rec, "2000-01-01", addDays(ws, -1), today);
    const carry = carryEarned - adv.filter((a) => a.workerId === w.id && a.businessDay < ws).reduce((s, a) => s + a.amountMillimes, 0)
      - pay.filter((p) => p.workerId === w.id && p.weekStart < ws).reduce((s, p) => s + p.amountMillimes, 0);
    const earned = earnedIn(w, rec, ws, we, today);
    const advances = adv.filter((a) => a.workerId === w.id && a.businessDay >= ws).reduce((s, a) => s + a.amountMillimes, 0);
    const paid = pay.filter((p) => p.workerId === w.id && p.weekStart === ws).reduce((s, p) => s + p.amountMillimes, 0);
    const days = eachDay(ws, we).map((d) => {
      const r = rec.get(w.id + "|" + d);
      const inService = d >= w.startDay && (!w.endDay || d <= w.endDay);
      return { day: d, halves: r ? r.halves : inService ? 2 : 0, counted: inService && d <= today };
    });
    if (!earned && !carry && !advances && !paid && w.endDay && w.endDay < ws) continue;
    rows.push({ worker: w, days, earned, advances, paid, carry, remaining: carry + earned - advances - paid });
  }
  const advancesList = await db.select().from(workerAdvances).where(and(gte(workerAdvances.businessDay, ws), lte(workerAdvances.businessDay, we))).orderBy(asc(workerAdvances.ts));
  const paymentsList = await db.select().from(wagePayments).where(eq(wagePayments.weekStart, ws)).orderBy(asc(wagePayments.ts));
  return { rows, today, advancesList, paymentsList };
}
