import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { devices, syncEvents } from "@/db/schema";
import type { DB } from "@/db";
import { raiseAlert } from "./audit";
import { sha256Hex } from "./crypto";
import { createOrder, OrderRejected, payOrder } from "./orders";
import { getSettings } from "./settings";
import { hashInput, type EventEnvelope, type OrderCreatePayload, type OrderPayPayload } from "@/lib/canonical";
import { shiftInfo } from "@/lib/time";

export const MAX_BATCH = 50;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const base = {
  client_event_id: z.string().uuid(),
  device_id: z.string().uuid(),
  seq: z.number().int().positive(),
  client_ts: z.number().int().positive(),
  clock_offset_ms: z.number().int(),
  prev_hash: hex64.nullable(),
  hash: hex64,
};
export const envelopeSchema = z.union([
  z.object({
    ...base,
    type: z.literal("order.create"),
    payload: z.object({
      items: z.array(z.object({ product_id: z.number().int().positive(), qty: z.number().int().min(1).max(99) })).min(1).max(60),
      payment: z.enum(["cash", "ticket", "later"]),
      ticket_token_hash: hex64.optional(),
      ticket_code_hash: hex64.optional(),
      table_ref: z.string().max(20).optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...base,
    type: z.literal("order.pay"),
    payload: z.object({
      order_id: z.string().uuid(),
      payment: z.enum(["cash", "ticket"]),
      ticket_token_hash: hex64.optional(),
      ticket_code_hash: hex64.optional(),
    }).strict(),
  }).strict(),
]);

export type Device = typeof devices.$inferSelect;

export interface PushResult {
  acked: string[];
  rejected: { client_event_id: string; reason: string }[];
  server_time: number;
}

export function computeEventHash(env: Omit<EventEnvelope, "hash">): string {
  return sha256Hex(hashInput(env));
}

/** Spec §8.3/§8.4 — validate & process a batch from one device. Idempotent by client_event_id. */
export async function processPush(db: DB, device: Device, rawEvents: unknown[], now = new Date()): Promise<PushResult> {
  const res: PushResult = { acked: [], rejected: [], server_time: Date.now() };
  if (rawEvents.length > MAX_BATCH) throw new Error("batch too large");
  const s = await getSettings(db);
  const parsed: { env: EventEnvelope | null; raw: unknown; error?: string }[] = rawEvents.map((raw) => {
    const p = envelopeSchema.safeParse(raw);
    return p.success ? { env: p.data as EventEnvelope, raw } : { env: null, raw, error: p.error.issues[0]?.message ?? "invalid" };
  });
  parsed.sort((a, b) => (a.env?.seq ?? 0) - (b.env?.seq ?? 0));

  let dev = (await db.select().from(devices).where(eq(devices.id, device.id)))[0];
  for (const item of parsed) {
    const rawId = (item.raw as { client_event_id?: unknown })?.client_event_id;
    if (!item.env) {
      res.rejected.push({ client_event_id: typeof rawId === "string" ? rawId : "?", reason: `invalid: ${item.error}` });
      continue;
    }
    const env = item.env;
    // idempotency: a re-send is acknowledged silently
    const [dup] = await db.select().from(syncEvents).where(eq(syncEvents.clientEventId, env.client_event_id));
    if (dup) {
      if (dup.status === "accepted") res.acked.push(env.client_event_id);
      else res.rejected.push({ client_event_id: env.client_event_id, reason: dup.reason ?? "rejected" });
      continue;
    }
    if (env.device_id !== dev.id) {
      res.rejected.push({ client_event_id: env.client_event_id, reason: "device_mismatch" });
      continue;
    }
    const info = shiftInfo(now, s.morning_start_hour, s.evening_start_hour);
    const { hash, ...rest } = env;
    if (computeEventHash(rest) !== hash) {
      await db.insert(syncEvents).values({ deviceId: dev.id, seq: env.seq, clientEventId: env.client_event_id, type: env.type, payload: env as object, prevHash: env.prev_hash, hash: env.hash, status: "rejected", reason: "hash_invalid" });
      await raiseAlert(db, { severity: "critical", type: "hash_invalid", ref: `device:${dev.id}:${env.seq}`, ...info, message: `حدث بتوقيع غير صالح من الجهاز ${dev.name} (رقم ${env.seq}) — قد يكون معدّلاً` });
      res.rejected.push({ client_event_id: env.client_event_id, reason: "hash_invalid" });
      continue;
    }
    if (env.seq <= dev.lastSeq) {
      await db.insert(syncEvents).values({ deviceId: dev.id, seq: env.seq, clientEventId: env.client_event_id, type: env.type, payload: env as object, prevHash: env.prev_hash, hash: env.hash, status: "rejected", reason: "sequence_regression" });
      await raiseAlert(db, { severity: "critical", type: "sequence_regression", dedupeKey: `seqreg:${dev.id}`, ...info, message: `الجهاز ${dev.name} أرسل رقماً تسلسلياً قديماً (${env.seq} ≤ ${dev.lastSeq}) — ربما تم مسح بيانات الجهاز. أعد ربط الجهاز.` });
      res.rejected.push({ client_event_id: env.client_event_id, reason: "sequence_regression" });
      continue;
    }
    const flags: string[] = [];
    if (env.seq > dev.lastSeq + 1) {
      flags.push("sequence_gap");
      await raiseAlert(db, { severity: "critical", type: "sequence_gap", ref: `device:${dev.id}:${dev.lastSeq + 1}-${env.seq - 1}`, ...info, message: `فجوة في تسلسل الجهاز ${dev.name}: الأرقام ${dev.lastSeq + 1}…${env.seq - 1} مفقودة (طلبات محذوفة أو غير مرسلة)` });
    } else if (dev.lastHash !== null && env.prev_hash !== dev.lastHash) {
      flags.push("chain_broken");
      await raiseAlert(db, { severity: "critical", type: "hash_chain_broken", ref: `device:${dev.id}:${env.seq}`, ...info, message: `سلسلة التحقق مكسورة على الجهاز ${dev.name} عند الرقم ${env.seq} — سجلات محلية ربما عُدّلت` });
    }
    // time correction (spec §8.5)
    const clientTs = new Date(env.client_ts);
    let effective = new Date(env.client_ts + env.clock_offset_ms);
    if (dev.lastClockOffsetMs !== null && Math.abs(env.clock_offset_ms - dev.lastClockOffsetMs) > s.clock_skew_threshold_ms) {
      flags.push("clock_skew");
      await raiseAlert(db, { severity: "warn", type: "clock_skew", dedupeKey: `clock_skew:${dev.id}:${info.businessDay}`, ...info, message: `تغيّر كبير في ساعة الجهاز ${dev.name} (${Math.round((env.clock_offset_ms - dev.lastClockOffsetMs) / 1000)} ث)` });
    }
    if (effective.getTime() > now.getTime() + s.future_tolerance_min * 60_000) {
      flags.push("clock_skew", "future_ts");
      await raiseAlert(db, { severity: "warn", type: "clock_skew", ref: `device:${dev.id}:${env.seq}`, ...info, message: `طلب بتوقيت في المستقبل من الجهاز ${dev.name} — تم استعمال وقت الاستلام` });
      effective = now;
    }
    if (now.getTime() - effective.getTime() > s.max_offline_hours * 3_600_000) {
      flags.push("late_sync");
      await raiseAlert(db, { severity: "info", type: "late_sync", dedupeKey: `late_sync:${dev.id}:${info.businessDay}`, ...info, message: `طلبات وصلت متأخرة أكثر من ${s.max_offline_hours} ساعة من الجهاز ${dev.name}` });
    }

    const label = `${dev.name}-${String(env.seq).padStart(4, "0")}`;
    try {
      await db.transaction(async (tx) => {
        await tx.insert(syncEvents).values({ deviceId: dev.id, seq: env.seq, clientEventId: env.client_event_id, type: env.type, payload: env as object, prevHash: env.prev_hash, hash: env.hash, status: "accepted" });
        if (env.type === "order.pay") {
          const pl = env.payload as OrderPayPayload;
          await payOrder(tx, {
            orderId: pl.order_id, payment: pl.payment, at: effective, deviceId: dev.id, label,
            ticketTokenHash: pl.ticket_token_hash ?? null, ticketCodeHash: pl.ticket_code_hash ?? null, actor: `device:${dev.name}`,
          });
        } else {
          const pl = env.payload as OrderCreatePayload;
          await createOrder(tx, {
            id: env.client_event_id, deviceId: dev.id, deviceSeq: env.seq, orderLabel: label, clientTs, effectiveTs: effective,
            receivedAt: now, items: pl.items, payment: pl.payment, tableRef: pl.table_ref ?? null,
            ticketTokenHash: pl.ticket_token_hash ?? null, ticketCodeHash: pl.ticket_code_hash ?? null,
            flags: [...new Set(flags)], actor: `device:${dev.name}`,
          });
        }
        await tx.update(devices).set({ lastSeq: env.seq, lastHash: env.hash, lastClockOffsetMs: env.clock_offset_ms, lastSyncAt: now, lastSeenAt: now }).where(eq(devices.id, dev.id));
      });
      res.acked.push(env.client_event_id);
    } catch (e) {
      const reason = e instanceof OrderRejected ? e.code : "processing_error";
      // keep the raw event (nothing is lost) and advance the chain: the event itself is authentic
      await db.insert(syncEvents).values({ deviceId: dev.id, seq: env.seq, clientEventId: env.client_event_id, type: env.type, payload: env as object, prevHash: env.prev_hash, hash: env.hash, status: "rejected", reason });
      await db.update(devices).set({ lastSeq: env.seq, lastHash: env.hash, lastClockOffsetMs: env.clock_offset_ms, lastSyncAt: now, lastSeenAt: now }).where(eq(devices.id, dev.id));
      // (alerts raised inside the rolled-back transaction are lost, so the alert is raised here)
      const alertType = ({ unknown_product: "unknown_product", already_paid: "double_payment", order_void: "pay_after_void" } as Record<string, string>)[reason] ?? "rejected_event";
      await raiseAlert(db, { severity: "warn", type: alertType, ref: `device:${dev.id}:${env.seq}`, ...info, message: `حدث مرفوض من ${dev.name} (${label}): ${(e as Error).message}` });
      if (!(e instanceof OrderRejected)) console.error("sync processing error", e);
      res.rejected.push({ client_event_id: env.client_event_id, reason });
    }
    dev = (await db.select().from(devices).where(eq(devices.id, dev.id)))[0];
  }
  await db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, dev.id));
  res.server_time = Date.now();
  return res;
}
