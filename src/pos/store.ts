"use client";
/**
 * Tablet local storage (IndexedDB) — spec §8.1.
 * Stores: meta (device identity, next seq, last hash, clock offset), config (catalogue WITHOUT prices),
 * events (append-only outbox + permanent local log), used_tickets (locally consumed ticket hashes).
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { canonicalJson, type EventEnvelope, type EventType, type OrderCreatePayload, type OrderPayPayload } from "@/lib/canonical";
import { sha256Hex, uuidv4 } from "@/lib/sha256";

export interface DeviceConfig {
  business_name: string;
  device_name: string;
  products: { id: number; name_ar: string; name_fr: string | null; category: string | null; color: string | null; image?: string | null; sort_order: number }[];
  settings: { morning_start_hour: number; evening_start_hour: number };
  valid_tickets: { token_hashes: string[]; code_hashes: string[] };
  /** pay-later orders of this device still open on the server */
  open_orders?: string[];
  /** open pay-later orders entered or corrected by the Owner (not in this tablet's local log) */
  open_order_details?: { id: string; label: string; table_ref: string | null; ts: number; items: { product_id: number; qty: number }[] }[];
  config_version: string;
  server_time: number;
  /** local time when this config was received (orders synced after it are not in open_orders yet) */
  fetched_at?: number;
}

export interface StoredEvent {
  client_event_id: string;
  seq: number;
  status: "pending" | "sent" | "rejected";
  envelope: EventEnvelope;
  created_at: number;
  sent_at?: number;
  reason?: string;
}

interface Meta {
  device_id?: string; device_key?: string; device_name?: string;
  next_seq?: number; last_hash?: string | null; clock_offset_ms?: number; offset_measured_at?: number;
}

interface PosDB extends DBSchema {
  meta: { key: string; value: unknown };
  config: { key: string; value: DeviceConfig };
  events: { key: string; value: StoredEvent; indexes: { by_status: string; by_seq: number } };
  used_tickets: { key: string; value: { hash: string; at: number } };
}

let dbp: Promise<IDBPDatabase<PosDB>> | null = null;
export function posDb() {
  if (!dbp) {
    dbp = openDB<PosDB>("cafe-pos", 1, {
      upgrade(db) {
        db.createObjectStore("meta");
        db.createObjectStore("config");
        const ev = db.createObjectStore("events", { keyPath: "client_event_id" });
        ev.createIndex("by_status", "status");
        ev.createIndex("by_seq", "seq");
        db.createObjectStore("used_tickets", { keyPath: "hash" });
      },
    });
  }
  return dbp;
}

export async function getMeta(): Promise<Meta> {
  const db = await posDb();
  const keys = ["device_id", "device_key", "device_name", "next_seq", "last_hash", "clock_offset_ms", "offset_measured_at"] as const;
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = await db.get("meta", k);
  return out as Meta;
}

export async function setMeta(values: Meta) {
  const db = await posDb();
  const tx = db.transaction("meta", "readwrite");
  for (const [k, v] of Object.entries(values)) await tx.store.put(v, k);
  await tx.done;
}

export async function saveConfig(cfg: DeviceConfig) {
  const db = await posDb();
  await db.put("config", cfg, "current");
}

export async function loadConfig(): Promise<DeviceConfig | undefined> {
  const db = await posDb();
  return db.get("config", "current");
}

/**
 * Append an event (order.create / order.pay) atomically: seq, prev_hash and the event are written in ONE transaction,
 * BEFORE the success screen is shown (spec §8.6). Hashing is synchronous so the transaction stays open.
 */
export async function appendEvent(type: EventType, payload: EventEnvelope["payload"]): Promise<StoredEvent> {
  const db = await posDb();
  const tx = db.transaction(["meta", "events", "used_tickets"], "readwrite");
  const meta = tx.objectStore("meta");
  const deviceId = (await meta.get("device_id")) as string;
  if (!deviceId) throw new Error("device not paired");
  const seq = ((await meta.get("next_seq")) as number | undefined) ?? 1;
  const prevHash = ((await meta.get("last_hash")) as string | null | undefined) ?? null;
  const offset = ((await meta.get("clock_offset_ms")) as number | undefined) ?? 0;
  const base: Omit<EventEnvelope, "hash"> = {
    client_event_id: uuidv4(), device_id: deviceId, seq, type,
    client_ts: Date.now(), clock_offset_ms: Math.round(offset), payload, prev_hash: prevHash,
  };
  const hash = sha256Hex((prevHash ?? "") + canonicalJson(base));
  const ev: StoredEvent = { client_event_id: base.client_event_id, seq, status: "pending", envelope: { ...base, hash }, created_at: Date.now() };
  await tx.objectStore("events").add(ev);
  await meta.put(seq + 1, "next_seq");
  await meta.put(hash, "last_hash");
  const th = payload.ticket_token_hash ?? payload.ticket_code_hash;
  if (th) await tx.objectStore("used_tickets").put({ hash: th, at: Date.now() });
  await tx.done;
  return ev;
}

export async function pendingEvents(limit = 50): Promise<StoredEvent[]> {
  const db = await posDb();
  const deviceId = await db.get("meta", "device_id");
  const all = await db.getAllFromIndex("events", "by_status", "pending");
  // events of a previous (revoked) pairing stay stored locally but are not sent with the new identity
  return all.filter((e) => e.envelope.device_id === deviceId).sort((a, b) => a.seq - b.seq).slice(0, limit);
}

export async function pendingCount(): Promise<number> {
  const db = await posDb();
  return db.countFromIndex("events", "by_status", "pending");
}

export async function markEvents(acked: string[], rejected: { client_event_id: string; reason: string }[]) {
  const db = await posDb();
  const tx = db.transaction("events", "readwrite");
  const now = Date.now();
  for (const id of acked) {
    const e = await tx.store.get(id);
    if (e) await tx.store.put({ ...e, status: "sent", sent_at: now });
  }
  for (const r of rejected) {
    const e = await tx.store.get(r.client_event_id);
    if (e) await tx.store.put({ ...e, status: "rejected", reason: r.reason, sent_at: now });
  }
  await tx.done;
}

/** Keep sent events 30 days as an extra backup; never delete unsent events. */
export async function purgeOldEvents(days = 30) {
  const db = await posDb();
  const cutoff = Date.now() - days * 86_400_000;
  const tx = db.transaction(["events", "used_tickets"], "readwrite");
  let cur = await tx.objectStore("events").openCursor();
  while (cur) {
    const e = cur.value;
    if (e.status !== "pending" && (e.sent_at ?? e.created_at) < cutoff) await cur.delete();
    cur = await cur.continue();
  }
  let c2 = await tx.objectStore("used_tickets").openCursor();
  while (c2) {
    if (c2.value.at < cutoff) await c2.delete();
    c2 = await c2.continue();
  }
  await tx.done;
}

export async function isTicketUsedLocally(hash: string) {
  const db = await posDb();
  return !!(await db.get("used_tickets", hash));
}

export interface UnpaidOrder {
  id: string;
  seq: number;
  created_at: number;
  items: { product_id: number; qty: number }[];
  table_ref?: string;
  /** server label for orders entered/corrected by the Owner (e.g. ADM-0003) */
  label?: string;
}

/**
 * Pay-later orders of this device not yet paid: created locally with payment "later", no local pay event,
 * and (once synced) still open on the server — so orders voided or settled by the Owner disappear.
 */
export async function listUnpaid(serverOpen?: string[], serverDetails?: DeviceConfig["open_order_details"], fetchedAt = 0): Promise<UnpaidOrder[]> {
  const db = await posDb();
  const deviceId = await db.get("meta", "device_id");
  const all = (await db.getAll("events")).filter((e) => e.envelope.device_id === deviceId && e.status !== "rejected");
  const paid = new Set(all.filter((e) => e.envelope.type === "order.pay").map((e) => (e.envelope.payload as OrderPayPayload).order_id));
  const open = serverOpen ? new Set(serverOpen) : null;
  const local = all
    .filter((e) => e.envelope.type === "order.create" && (e.envelope.payload as OrderCreatePayload).payment === "later")
    .filter((e) => !paid.has(e.client_event_id))
    // shown if not synced yet, or still open on the server, or synced after the last server list was fetched.
    // An order deleted by the Owner is not in the server list any more → it disappears at the next refresh.
    .filter((e) => e.status === "pending" || !open || open.has(e.client_event_id) || (e.sent_at ?? 0) > fetchedAt)
    .sort((a, b) => a.seq - b.seq)
    .map((e) => {
      const p = e.envelope.payload as OrderCreatePayload;
      return { id: e.client_event_id, seq: e.seq, created_at: e.created_at, items: p.items, table_ref: p.table_ref } as UnpaidOrder;
    });
  const known = new Set(local.map((o) => o.id));
  const remote = (serverDetails ?? [])
    .filter((d) => !known.has(d.id) && !paid.has(d.id))
    .map((d) => ({ id: d.id, seq: 0, created_at: d.ts, items: d.items, table_ref: d.table_ref ?? undefined, label: d.label }));
  return [...local, ...remote].sort((a, b) => a.created_at - b.created_at);
}
