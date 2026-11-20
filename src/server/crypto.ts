import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 8-char Crockford base32 code (40 random bits). */
export function randomShortCode(len = 8): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += CROCKFORD[bytes[i] & 31];
  return out;
}

export function randomDigits(n: number): string {
  let s = "";
  while (s.length < n) s += crypto.randomInt(0, 10).toString();
  return s;
}

// ---------------------------------------------------------------- secrets
interface Secrets { sessionSecret: string; totpKey: string; cronSecret: string }
let cached: Secrets | null = null;

export function getSecrets(): Secrets {
  if (cached) return cached;
  const envS = process.env.SESSION_SECRET?.trim();
  const envT = process.env.TOTP_ENCRYPTION_KEY?.trim();
  if (envS && envT) {
    cached = { sessionSecret: envS, totpKey: envT, cronSecret: process.env.CRON_SECRET?.trim() || "" };
    return cached;
  }
  if (process.env.DATABASE_URL?.trim()) {
    throw new Error("SESSION_SECRET and TOTP_ENCRYPTION_KEY must be set in production (see .env.example)");
  }
  // Local mode: generate once and keep in ./data/secrets.json (never committed).
  const file = path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "secrets.json");
  let data: Partial<Secrets> = {};
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first run */ }
  if (!data.sessionSecret || !data.totpKey || !data.cronSecret) {
    data = {
      sessionSecret: data.sessionSecret || crypto.randomBytes(32).toString("hex"),
      totpKey: data.totpKey || crypto.randomBytes(32).toString("hex"),
      cronSecret: data.cronSecret || crypto.randomBytes(24).toString("hex"),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
  cached = {
    sessionSecret: envS || data.sessionSecret!,
    totpKey: envT || data.totpKey!,
    cronSecret: process.env.CRON_SECRET?.trim() || data.cronSecret!,
  };
  return cached;
}

function keyFrom(secret: string, purpose: string): Buffer {
  return crypto.createHash("sha256").update(purpose + ":" + secret).digest();
}

export function encrypt(plain: string, purpose = "totp"): string {
  const key = keyFrom(getSecrets().totpKey, purpose);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function decrypt(blob: string, purpose = "totp"): string {
  const [iv, tag, enc] = blob.split(".");
  const key = keyFrom(getSecrets().totpKey, purpose);
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
}

// ---------------------------------------------------------------- passwords (scrypt)
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltB, hashB] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hashB, "base64url");
  const actual = crypto.scryptSync(pw, Buffer.from(saltB, "base64url"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------- TOTP (RFC 6238, SHA1, 30 s, 6 digits)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error("bad base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpAt(secretB32: string, timeMs: number, step = 30): string {
  const counter = Math.floor(timeMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", base32Decode(secretB32)).update(buf).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
  return code;
}

export function verifyTotp(secretB32: string, code: string, nowMs = Date.now()): boolean {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  for (const w of [-1, 0, 1]) {
    const exp = totpAt(secretB32, nowMs + w * 30_000);
    if (crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(c))) return true;
  }
  return false;
}
