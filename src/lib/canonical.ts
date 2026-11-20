/**
 * Canonical JSON (sorted keys, no whitespace) + event hash definition shared by tablet and server.
 * hash = sha256_hex( (prev_hash ?? "") + canonicalJson(envelope without "hash") )   — spec §8.2
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/** order.create — payment "later" = served now, paid when the customer leaves (order.pay follows). */
export interface OrderCreatePayload {
  items: { product_id: number; qty: number }[];
  payment: "cash" | "ticket" | "later";
  ticket_token_hash?: string;
  ticket_code_hash?: string;
  table_ref?: string;
}

/** order.pay — closes an order created with payment "later". */
export interface OrderPayPayload {
  order_id: string;
  payment: "cash" | "ticket";
  ticket_token_hash?: string;
  ticket_code_hash?: string;
}

export type EventType = "order.create" | "order.pay";

export interface EventEnvelope {
  client_event_id: string;
  device_id: string;
  seq: number;
  type: EventType;
  client_ts: number;
  clock_offset_ms: number;
  payload: OrderCreatePayload | OrderPayPayload;
  prev_hash: string | null;
  hash: string;
}

export function hashInput(env: Omit<EventEnvelope, "hash">): string {
  const { ...rest } = env as EventEnvelope;
  delete (rest as Partial<EventEnvelope>).hash;
  return (env.prev_hash ?? "") + canonicalJson(rest);
}

/** Normalise a ticket short code typed by a worker (Crockford base32: case-insensitive, O→0, I/L→1, no dashes). */
export function normaliseShortCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** Extract the raw token from QR content: either the bare token or a URL ending in /t/<token>. */
export function extractTicketToken(qr: string): string {
  const s = qr.trim();
  const m = /\/t\/([A-Za-z0-9_-]+)\/?$/.exec(s);
  return m ? m[1] : s;
}
