"use client";
import { getMeta, markEvents, pendingCount, pendingEvents, purgeOldEvents, saveConfig, setMeta, type DeviceConfig } from "./store";

export const APP_VERSION = "1.0.0";

async function api(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const meta = await getMeta();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 15_000);
  try {
    return await fetch(path, {
      ...init,
      signal: ctl.signal,
      cache: "no-store",
      headers: { "content-type": "application/json", authorization: `Bearer ${meta.device_key ?? ""}`, ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** offset = server_time − local midpoint of the request (spec §8.5). */
async function updateOffset(serverTime: number, t0: number, t1: number) {
  if (!Number.isFinite(serverTime)) return;
  const offset = Math.round(serverTime - (t0 + t1) / 2);
  await setMeta({ clock_offset_ms: offset, offset_measured_at: Date.now() });
}

export class Unauthorized extends Error {}

export async function pullConfig(): Promise<DeviceConfig> {
  const t0 = Date.now();
  const r = await api("/api/sync/config");
  const t1 = Date.now();
  if (r.status === 401) throw new Unauthorized("unauthorized");
  if (!r.ok) throw new Error(`config ${r.status}`);
  const cfg = (await r.json()) as DeviceConfig;
  await updateOffset(cfg.server_time, t0, t1);
  await saveConfig(cfg);
  return cfg;
}

/** Push pending events oldest first in batches ≤ 50; mark sent ONLY after ack. Returns remaining pending count. */
export async function pushPending(): Promise<number> {
  const meta = await getMeta();
  for (let round = 0; round < 20; round++) {
    const batch = await pendingEvents(50);
    if (!batch.length) break;
    const t0 = Date.now();
    const r = await api("/api/sync/push", { method: "POST", body: JSON.stringify({ device_id: meta.device_id, events: batch.map((e) => e.envelope) }), timeoutMs: 30_000 });
    const t1 = Date.now();
    if (r.status === 401) throw new Unauthorized("unauthorized");
    if (!r.ok) throw new Error(`push ${r.status}`);
    const res = (await r.json()) as { acked: string[]; rejected: { client_event_id: string; reason: string }[]; server_time: number };
    await markEvents(res.acked, res.rejected);
    await updateOffset(res.server_time, t0, t1);
    if (!res.acked.length && !res.rejected.length) break;
  }
  await purgeOldEvents(30).catch(() => {});
  return pendingCount();
}

export async function heartbeat() {
  const pending = await pendingCount();
  await api("/api/device/heartbeat", { method: "POST", body: JSON.stringify({ app_version: APP_VERSION, pending }), timeoutMs: 8000 }).catch(() => {});
}

/** Online ticket validity check. Returns null when the server cannot be reached (→ offline validation). */
export async function checkTicketOnline(h: { token_hash?: string; code_hash?: string }): Promise<boolean | null> {
  try {
    const r = await api("/api/pos/ticket-check", { method: "POST", body: JSON.stringify(h), timeoutMs: 4000 });
    if (!r.ok) return null;
    const j = (await r.json()) as { valid: boolean };
    return !!j.valid;
  } catch {
    return null;
  }
}

export async function pair(code: string) {
  const r = await fetch("/api/device/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  if (!r.ok) throw new Error("invalid_code");
  const j = (await r.json()) as { device_id: string; device_key: string; name: string; server_time: number };
  await setMeta({ device_id: j.device_id, device_key: j.device_key, device_name: j.name, next_seq: 1, last_hash: null, clock_offset_ms: j.server_time - Date.now() });
  return j;
}
