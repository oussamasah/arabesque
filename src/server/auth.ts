import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { adminSessions, admins, loginAttempts } from "@/db/schema";
import { getDb, type Exec } from "@/db";
import { audit, raiseAlert } from "./audit";
import { decrypt, encrypt, hashPassword, newTotpSecret, randomToken, sha256Hex, verifyPassword, verifyTotp } from "./crypto";

export const SESSION_COOKIE = "cafe_admin";
const SESSION_HOURS = 12;
const PRE2FA_MINUTES = 10;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

export function validatePasswordStrength(pw: string) {
  if (pw.length < 10) throw new Error("كلمة السر يجب أن تكون 10 أحرف على الأقل");
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new Error("كلمة السر يجب أن تحتوي حروفاً وأرقاماً");
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] || h.get("x-real-ip") || "local").trim().slice(0, 64);
}

export async function adminExists(db: Exec) {
  const [r] = await db.select({ n: sql<string>`count(*)` }).from(admins);
  return Number(r.n) > 0;
}

export async function createFirstAdmin(db: Exec, email: string, password: string) {
  if (await adminExists(db)) throw new Error("الحساب موجود مسبقاً");
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error("بريد إلكتروني غير صالح");
  validatePasswordStrength(password);
  const [a] = await db.insert(admins).values({ email: e, passwordHash: hashPassword(password) }).returning();
  await audit(db, e, "admin.create", "admin", a.id, null, { email: e });
  return a;
}

async function isLocked(db: Exec, keys: string[]) {
  const since = new Date(Date.now() - LOCK_MINUTES * 60_000);
  for (const key of keys) {
    const [r] = await db.select({ n: sql<string>`count(*)` }).from(loginAttempts)
      .where(and(eq(loginAttempts.key, key), eq(loginAttempts.success, false), gte(loginAttempts.ts, since)));
    if (Number(r.n) >= MAX_FAILS) return true;
  }
  return false;
}

async function recordAttempt(db: Exec, keys: string[], success: boolean) {
  for (const key of keys) await db.insert(loginAttempts).values({ key, success });
}

async function newSession(db: Exec, adminId: number, stage: "totp" | "full", ip: string) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + (stage === "full" ? SESSION_HOURS * 3_600_000 : PRE2FA_MINUTES * 60_000));
  await db.insert(adminSessions).values({ tokenHash: sha256Hex(token), adminId, stage, expiresAt, ip });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "strict", path: "/", expires: expiresAt,
    secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1",
  });
}

/** Step 1: email + password. Returns next stage. */
export async function loginPassword(email: string, password: string): Promise<"totp" | "enroll" | "full"> {
  const db = await getDb();
  const ip = await clientIp();
  const e = email.trim().toLowerCase();
  const keys = [`email:${e}`, `ip:${ip}`];
  if (await isLocked(db, keys)) throw new Error(`محاولات كثيرة. حاول بعد ${LOCK_MINUTES} دقيقة.`);
  const [a] = await db.select().from(admins).where(eq(admins.email, e));
  const ok = a ? verifyPassword(password, a.passwordHash) : (verifyPassword(password, "scrypt$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(86)), false);
  await recordAttempt(db, keys, ok);
  if (!a || !ok) {
    if (await isLocked(db, keys)) await raiseAlert(db, { severity: "critical", type: "login_lockout", dedupeKey: `lockout:${e}`, message: `قفل تسجيل الدخول بعد محاولات فاشلة (${e}, IP ${ip})` });
    throw new Error("البريد أو كلمة السر غير صحيحة");
  }
  if (a.totpEnabled) { await newSession(db, a.id, "totp", ip); return "totp"; }
  // 2FA not set up yet: allow only the enrollment page
  await newSession(db, a.id, "totp", ip);
  return "enroll";
}

export async function loginTotp(code: string) {
  const db = await getDb();
  const ip = await clientIp();
  const sess = await currentSession(db, "totp");
  if (!sess) throw new Error("انتهت الجلسة، أعد تسجيل الدخول");
  const keys = [`totp:${sess.admin.id}`, `ip:${ip}`];
  if (await isLocked(db, keys)) throw new Error(`محاولات كثيرة. حاول بعد ${LOCK_MINUTES} دقيقة.`);
  const ok = !!sess.admin.totpSecretEnc && verifyTotp(decrypt(sess.admin.totpSecretEnc), code);
  await recordAttempt(db, keys, ok);
  if (!ok) throw new Error("رمز التحقق غير صحيح");
  await db.delete(adminSessions).where(eq(adminSessions.id, sess.sessionId));
  await newSession(db, sess.admin.id, "full", ip);
  await audit(db, sess.admin.email, "admin.login", "admin", sess.admin.id, null, null, ip);
}

/** 2FA enrollment: generate a pending secret (stored encrypted, enabled only after a valid code). */
export async function startTotpEnrollment(db: Exec, adminId: number) {
  const secret = newTotpSecret();
  await db.update(admins).set({ totpSecretEnc: encrypt(secret) }).where(eq(admins.id, adminId));
  return secret;
}

export async function confirmTotpEnrollment(code: string) {
  const db = await getDb();
  const ip = await clientIp();
  const sess = (await currentSession(db, "full")) ?? (await currentSession(db, "totp"));
  if (!sess) throw new Error("انتهت الجلسة، أعد تسجيل الدخول");
  if (sess.admin.totpEnabled && sess.stage !== "full") throw new Error("غير مسموح");
  if (!sess.admin.totpSecretEnc || !verifyTotp(decrypt(sess.admin.totpSecretEnc), code)) throw new Error("رمز التحقق غير صحيح");
  await db.update(admins).set({ totpEnabled: true }).where(eq(admins.id, sess.admin.id));
  await db.delete(adminSessions).where(eq(adminSessions.id, sess.sessionId));
  await newSession(db, sess.admin.id, "full", ip);
  await audit(db, sess.admin.email, "admin.2fa_enabled", "admin", sess.admin.id, null, null, ip);
}

export async function changePassword(current: string, next: string) {
  const db = await getDb();
  const a = await requireAdmin();
  const [row] = await db.select().from(admins).where(eq(admins.id, a.id));
  if (!verifyPassword(current, row.passwordHash)) throw new Error("كلمة السر الحالية غير صحيحة");
  validatePasswordStrength(next);
  await db.update(admins).set({ passwordHash: hashPassword(next) }).where(eq(admins.id, a.id));
  await db.delete(adminSessions).where(and(eq(adminSessions.adminId, a.id), sql`${adminSessions.tokenHash} <> ${a.tokenHash}`));
  await audit(db, a.email, "admin.password_change", "admin", a.id, null, null, await clientIp());
}

async function currentSession(db: Exec, stage: "totp" | "full") {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const th = sha256Hex(token);
  const [s] = await db.select().from(adminSessions).where(eq(adminSessions.tokenHash, th));
  if (!s || s.stage !== stage || s.expiresAt.getTime() < Date.now()) return null;
  const [a] = await db.select().from(admins).where(eq(admins.id, s.adminId));
  if (!a) return null;
  return { sessionId: s.id, stage: s.stage, admin: a, tokenHash: th };
}

export async function getPendingSession() {
  const db = await getDb();
  return currentSession(db, "totp");
}

export interface AdminCtx { id: number; email: string; tokenHash: string; totpEnabled: boolean }

export async function getAdmin(): Promise<AdminCtx | null> {
  const db = await getDb();
  const s = await currentSession(db, "full");
  if (!s) return null;
  if (!s.admin.totpEnabled) return null; // 2FA is mandatory
  return { id: s.admin.id, email: s.admin.email, tokenHash: s.tokenHash, totpEnabled: s.admin.totpEnabled };
}

/** Use in every admin page / server action. Redirects to login when not fully authenticated. */
export async function requireAdmin(): Promise<AdminCtx> {
  const a = await getAdmin();
  if (!a) redirect("/admin/login");
  return a;
}

export async function logout() {
  const db = await getDb();
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(adminSessions).where(eq(adminSessions.tokenHash, sha256Hex(token)));
  jar.delete(SESSION_COOKIE);
}
