import "server-only";
import crypto from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { creditLedger, customers, tickets, ticketSheets } from "@/db/schema";
import type { Exec } from "@/db";
import { audit, raiseAlert, resolveAlerts } from "./audit";
import { decrypt, encrypt, randomShortCode, randomToken, sha256Hex } from "./crypto";
import { getSettings } from "./settings";
import { normaliseShortCode } from "@/lib/canonical";
import { assertInt } from "@/lib/money";
import { shiftInfo } from "@/lib/time";

export async function createCustomer(db: Exec, c: { name: string; phone?: string | null; note?: string | null; lowTicketsThreshold?: number | null }, actor: string) {
  if (!c.name.trim()) throw new Error("اسم الزبون مطلوب");
  const [row] = await db.insert(customers).values({ name: c.name.trim(), phone: c.phone || null, note: c.note || null, lowTicketsThreshold: c.lowTicketsThreshold ?? null }).returning();
  await audit(db, actor, "customer.create", "customer", row.id, null, row);
  return row;
}

export async function updateCustomer(db: Exec, id: number, c: { name: string; phone?: string | null; note?: string | null; lowTicketsThreshold?: number | null; active: boolean }, actor: string) {
  const [before] = await db.select().from(customers).where(eq(customers.id, id));
  if (!before) throw new Error("زبون غير موجود");
  const [row] = await db.update(customers).set({ name: c.name.trim(), phone: c.phone || null, note: c.note || null, lowTicketsThreshold: c.lowTicketsThreshold ?? null, active: c.active })
    .where(eq(customers.id, id)).returning();
  await audit(db, actor, "customer.update", "customer", id, before, row);
  return row;
}

/** Issue a printable sheet of single-use tickets for one customer (spec §7.6, Owner only). */
export async function issueSheet(db: Exec, input: {
  customerId: number; type: "free" | "credit"; count: number; maxAmountMillimes?: number | null; note?: string | null;
}, actor: string) {
  if (!["free", "credit"].includes(input.type)) throw new Error("نوع غير صالح");
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 200) throw new Error("عدد التذاكر بين 1 و 200");
  if (input.maxAmountMillimes != null) { assertInt(input.maxAmountMillimes, "cap"); if (input.maxAmountMillimes <= 0) throw new Error("السقف يجب أن يكون أكبر من صفر"); }
  const [cust] = await db.select().from(customers).where(eq(customers.id, input.customerId));
  if (!cust) throw new Error("زبون غير موجود");
  const now = new Date();
  const [sheet] = await db.insert(ticketSheets).values({
    customerId: cust.id, type: input.type, ticketCount: input.count, maxAmountMillimes: input.maxAmountMillimes ?? null,
    issuedAt: now, issuedBy: actor, note: input.note || null,
  }).returning();
  for (let i = 0; i < input.count; i++) {
    for (let attempt = 0; ; attempt++) {
      const token = randomToken(16); // 128-bit random, unguessable
      const code = randomShortCode(8);
      try {
        await db.insert(tickets).values({
          id: crypto.randomUUID(), sheetId: sheet.id, tokenHash: sha256Hex(token), tokenEnc: encrypt(token, "ticket"),
          shortCode: code, shortCodeHash: sha256Hex(code), type: input.type, customerId: cust.id, customerName: cust.name,
          maxAmountMillimes: input.maxAmountMillimes ?? null, status: "issued", issuedAt: now, issuedBy: actor, note: input.note || null,
        });
        break;
      } catch (e) {
        if (attempt > 5) throw e; // astronomically unlikely collision: retry
      }
    }
  }
  await audit(db, actor, "ticket.issue_sheet", "ticket_sheet", sheet.id, null, { ...sheet });
  await resolveAlerts(db, `low_tickets:${cust.id}`);
  return sheet;
}

export async function sheetForPrint(db: Exec, sheetId: number) {
  const [sheet] = await db.select().from(ticketSheets).where(eq(ticketSheets.id, sheetId));
  if (!sheet || sheet.deletedAt) throw new Error("ورقة غير موجودة");
  const rows = await db.select().from(tickets).where(eq(tickets.sheetId, sheetId)).orderBy(tickets.shortCode);
  return {
    sheet,
    tickets: rows.map((t) => ({ id: t.id, shortCode: t.shortCode, status: t.status, type: t.type, customerName: t.customerName, token: t.tokenEnc ? decrypt(t.tokenEnc, "ticket") : null })),
  };
}

export async function voidTicket(db: Exec, ticketId: string, reason: string, actor: string) {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!t) throw new Error("تذكرة غير موجودة");
  if (t.status !== "issued") throw new Error("لا يمكن إلغاء تذكرة مستعملة أو ملغاة");
  await db.update(tickets).set({ status: "void", note: [t.note, `ملغاة: ${reason}`].filter(Boolean).join(" — ") }).where(eq(tickets.id, ticketId));
  await audit(db, actor, "ticket.void", "ticket", ticketId, t, { status: "void", reason });
  if (t.customerId) await checkLowTickets(db, t.customerId);
}

/**
 * Edit a sheet: note, type and cap. Used tickets are history and keep their type/cap;
 * only still-valid (issued) tickets follow the change (credit is charged at use, so changing the type of unused tickets is safe).
 */
export async function updateSheet(db: Exec, sheetId: number, input: { note?: string | null; type: "free" | "credit"; maxAmountMillimes?: number | null }, actor: string) {
  const [before] = await db.select().from(ticketSheets).where(eq(ticketSheets.id, sheetId));
  if (!before || before.deletedAt) throw new Error("ورقة غير موجودة");
  if (!["free", "credit"].includes(input.type)) throw new Error("نوع غير صالح");
  if (input.maxAmountMillimes != null) { assertInt(input.maxAmountMillimes, "cap"); if (input.maxAmountMillimes <= 0) throw new Error("السقف يجب أن يكون أكبر من صفر"); }
  const [row] = await db.update(ticketSheets).set({ note: input.note || null, type: input.type, maxAmountMillimes: input.maxAmountMillimes ?? null })
    .where(eq(ticketSheets.id, sheetId)).returning();
  await db.update(tickets).set({ note: input.note || null, type: input.type, maxAmountMillimes: input.maxAmountMillimes ?? null })
    .where(and(eq(tickets.sheetId, sheetId), eq(tickets.status, "issued")));
  await audit(db, actor, "ticket.update_sheet", "ticket_sheet", sheetId, before, row);
  return row;
}

/** Delete a sheet: every unused ticket is voided (tablets stop accepting them); used tickets and their orders are untouched. */
export async function deleteSheet(db: Exec, sheetId: number, actor: string) {
  const [before] = await db.select().from(ticketSheets).where(eq(ticketSheets.id, sheetId));
  if (!before || before.deletedAt) throw new Error("ورقة غير موجودة");
  const voided = await db.update(tickets).set({ status: "void", note: "ورقة محذوفة" }).where(and(eq(tickets.sheetId, sheetId), eq(tickets.status, "issued"))).returning({ id: tickets.id });
  await db.update(ticketSheets).set({ deletedAt: new Date() }).where(eq(ticketSheets.id, sheetId));
  await audit(db, actor, "ticket.delete_sheet", "ticket_sheet", sheetId, before, { deleted: true, voided: voided.length });
  await checkLowTickets(db, before.customerId);
  return voided.length;
}

/** Edit one ticket's note (status changes go through void / cancelling the order that used it). */
export async function updateTicketNote(db: Exec, ticketId: string, note: string | null, actor: string) {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!t) throw new Error("تذكرة غير موجودة");
  await db.update(tickets).set({ note: note || null }).where(eq(tickets.id, ticketId));
  await audit(db, actor, "ticket.update", "ticket", ticketId, { note: t.note }, { note });
}

export async function findTicketByHash(db: Exec, h: { tokenHash?: string | null; codeHash?: string | null }) {
  const conds = [];
  if (h.tokenHash) conds.push(eq(tickets.tokenHash, h.tokenHash));
  if (h.codeHash) conds.push(eq(tickets.shortCodeHash, h.codeHash));
  if (!conds.length) return null;
  const [t] = await db.select().from(tickets).where(conds.length === 1 ? conds[0] : or(...conds)).limit(1);
  return t ?? null;
}

/** Online check from the tablet. Returns only valid/invalid (worker never sees owner/type/value). */
export async function checkTicketOnline(db: Exec, h: { tokenHash?: string | null; codeHash?: string | null }, deviceId: string) {
  const t = await findTicketByHash(db, h);
  if (!t) return false;
  if (t.status === "issued") return true;
  if (t.status === "used") {
    await raiseAlert(db, {
      severity: "warn", type: "ticket_reuse_attempt", ref: `ticket:${t.id}`,
      message: `محاولة استعمال تذكرة مستعملة (${t.shortCode} — ${t.customerName}) على الجهاز`,
      ...shiftInfo(new Date()),
    });
  }
  return false;
}

/** Hash list for offline validation on the tablet (only `issued` tickets; no names, no values). */
export async function validTicketHashes(db: Exec) {
  const rows = await db.select({ t: tickets.tokenHash, c: tickets.shortCodeHash }).from(tickets).where(eq(tickets.status, "issued"));
  return { token_hashes: rows.map((r) => r.t), code_hashes: rows.map((r) => r.c) };
}

export async function remainingTickets(db: Exec, customerId: number) {
  const [r] = await db.select({ n: sql<string>`count(*)` }).from(tickets).where(and(eq(tickets.customerId, customerId), eq(tickets.status, "issued")));
  return Number(r.n);
}

export async function checkLowTickets(db: Exec, customerId: number) {
  const s = await getSettings(db);
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!c) return;
  const threshold = c.lowTicketsThreshold ?? s.low_tickets_threshold;
  const left = await remainingTickets(db, customerId);
  const key = `low_tickets:${customerId}`;
  const [{ n: issuedEver }] = await db.select({ n: sql<string>`count(*)` }).from(tickets).where(eq(tickets.customerId, customerId));
  if (Number(issuedEver) > 0 && left <= threshold) {
    await raiseAlert(db, { severity: "info", type: "low_tickets", dedupeKey: key, message: `الزبون "${c.name}" بقيت له ${left} تذكرة — اطبع له ورقة جديدة` });
  } else {
    await resolveAlerts(db, key);
  }
}

// ---------------------------------------------------------------- credit
export async function customerBalance(db: Exec, customerId: number) {
  const [r] = await db.select({
    b: sql<string>`coalesce(sum(case when ${creditLedger.type} = 'payment' then -${creditLedger.amountMillimes} else ${creditLedger.amountMillimes} end), 0)`,
  }).from(creditLedger).where(eq(creditLedger.customerId, customerId));
  return Number(r.b);
}

/** Repayment: money goes directly to the Owner (not to any shift drawer); revenue on the repayment day. */
export async function recordRepayment(db: Exec, customerId: number, amountMillimes: number, ts: Date, note: string | null, actor: string) {
  assertInt(amountMillimes, "amount");
  if (amountMillimes <= 0) throw new Error("المبلغ يجب أن يكون أكبر من صفر");
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!c) throw new Error("زبون غير موجود");
  const s = await getSettings(db);
  const { businessDay } = shiftInfo(ts, s.morning_start_hour, s.evening_start_hour);
  const [row] = await db.insert(creditLedger).values({ customerId, ts, businessDay, type: "payment", amountMillimes, note, createdBy: actor }).returning();
  await audit(db, actor, "credit.payment", "customer", customerId, null, row);
  return row;
}

export async function recordCreditAdjustment(db: Exec, customerId: number, amountMillimes: number, note: string, actor: string) {
  assertInt(amountMillimes, "amount");
  if (!note.trim()) throw new Error("السبب مطلوب");
  const s = await getSettings(db);
  const now = new Date();
  const { businessDay } = shiftInfo(now, s.morning_start_hour, s.evening_start_hour);
  const [row] = await db.insert(creditLedger).values({ customerId, ts: now, businessDay, type: "adjustment", amountMillimes, note, createdBy: actor }).returning();
  await audit(db, actor, "credit.adjustment", "customer", customerId, null, row);
  return row;
}
