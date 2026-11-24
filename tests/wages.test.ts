import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers";
import { addAdvance, addWorker, payWage, setAttendance, todayDay, updateWorker, wagesInRange, weekReport } from "@/server/wages";
import { addDays, weekStart } from "@/lib/time";

describe("wages", () => {
  it("accrues daily, takes advances, supports partial payment (deferral) and keeps the past when the wage changes", async () => {
    const db = await createTestDb();
    const today = await todayDay(db);
    const ws = weekStart(today);
    const prev = addDays(ws, -7);
    const w = await addWorker(db, "فيصل", 25_000, prev, "t");
    const w2 = await addWorker(db, "لبشا", 30_000, prev, "t");

    // previous week: 7 full days each (unrecorded = full day)
    let r = await weekReport(db, prev);
    expect(r.rows.find((x) => x.worker.id === w.id)!.earned).toBe(7 * 25_000);
    expect(r.rows.find((x) => x.worker.id === w2.id)!.earned).toBe(7 * 30_000);

    // one absence + half day, an advance
    await setAttendance(db, [{ workerId: w.id, day: prev, halves: 0 }, { workerId: w.id, day: addDays(prev, 1), halves: 1 }], "t");
    await addAdvance(db, w.id, 20_000, new Date(addDays(prev, 2) + "T12:00:00Z"), "سلفة", "t");
    r = await weekReport(db, prev);
    const row = r.rows.find((x) => x.worker.id === w.id)!;
    expect(row.earned).toBe(5 * 25_000 + 12_500);
    expect(row.advances).toBe(20_000);
    expect(row.remaining).toBe(row.earned - 20_000);

    // partial payment: the rest is carried to the next week
    await payWage(db, w.id, 100_000, prev, new Date(), null, "t");
    r = await weekReport(db, prev);
    const left = r.rows.find((x) => x.worker.id === w.id)!.remaining;
    expect(left).toBe(row.earned - 20_000 - 100_000);
    const next = await weekReport(db, ws);
    expect(next.rows.find((x) => x.worker.id === w.id)!.carry).toBe(left);

    // wage change applies from today on, not to past days
    await updateWorker(db, w.id, { nameAr: "فيصل", wage: 40_000, endDay: null }, "t");
    r = await weekReport(db, prev);
    expect(r.rows.find((x) => x.worker.id === w.id)!.earned).toBe(row.earned);

    // profit expense = wages earned in the period
    expect(await wagesInRange(db, prev, addDays(prev, 6))).toBe(row.earned + 7 * 30_000);
  });
});
