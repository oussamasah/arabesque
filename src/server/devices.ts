import "server-only";
import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { devices, pairingCodes } from "@/db/schema";
import type { DB, Exec } from "@/db";
import { audit, resolveAlerts } from "./audit";
import { randomDigits, randomToken, sha256Hex } from "./crypto";

const PAIR_MINUTES = 10;

export async function createPairingCode(db: Exec, deviceName: string, actor: string) {
  const name = deviceName.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(name)) throw new Error("اسم الجهاز: حروف لاتينية/أرقام فقط (مثل T1)");
  const existing = await db.select().from(devices).where(and(eq(devices.name, name), eq(devices.status, "active")));
  if (existing.length) throw new Error(`يوجد جهاز نشط بالاسم ${name}. ألغِ ربطه أولاً أو اختر اسماً آخر.`);
  const code = randomDigits(8);
  const expiresAt = new Date(Date.now() + PAIR_MINUTES * 60_000);
  await db.insert(pairingCodes).values({ codeHash: sha256Hex(code), deviceName: name, expiresAt, createdBy: actor });
  await audit(db, actor, "device.pair_code", "device", name, null, { expiresAt });
  return { code, expiresAt, name };
}

/** Tablet redeems a one-time code and receives a random 256-bit device key (server stores only its hash). */
export async function redeemPairingCode(db: DB, code: string) {
  const clean = code.replace(/\D/g, "");
  if (clean.length !== 8) throw new Error("invalid_code");
  const [pc] = await db.select().from(pairingCodes)
    .where(and(eq(pairingCodes.codeHash, sha256Hex(clean)), isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, new Date())));
  if (!pc) throw new Error("invalid_code");
  const key = randomToken(32);
  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.update(pairingCodes).set({ usedAt: new Date() }).where(eq(pairingCodes.id, pc.id));
    await tx.insert(devices).values({ id, name: pc.deviceName, keyHash: sha256Hex(key), status: "active", pairedAt: new Date(), lastSeq: 0 });
    await audit(tx, pc.createdBy ?? "admin", "device.paired", "device", id, null, { name: pc.deviceName });
  });
  return { device_id: id, device_key: key, name: pc.deviceName };
}

export async function revokeDevice(db: Exec, id: string, actor: string) {
  const [d] = await db.select().from(devices).where(eq(devices.id, id));
  if (!d) throw new Error("جهاز غير موجود");
  await db.update(devices).set({ status: "revoked" }).where(eq(devices.id, id));
  await audit(db, actor, "device.revoke", "device", id, { status: d.status }, { status: "revoked" });
  await resolveAlerts(db, `device_silent:${id}`);
}

// simple per-device rate limit (per server instance)
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, max = 120, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return true; }
  b.n++;
  return b.n <= max;
}

/** Authenticate a tablet request: Authorization: Bearer <device_key>. */
export async function authDevice(db: Exec, req: Request) {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(h);
  if (!m) return null;
  const [d] = await db.select().from(devices).where(eq(devices.keyHash, sha256Hex(m[1])));
  if (!d || d.status !== "active") return null;
  return d;
}
