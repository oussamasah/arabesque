"use server";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  adminExists, changePassword, confirmTotpEnrollment, createFirstAdmin, loginPassword, loginTotp, logout,
} from "@/server/auth";

function errTo(path: string, e: unknown): never {
  redirect(`${path}?err=${encodeURIComponent((e as Error).message || "خطأ")}`);
}

export async function setupAction(fd: FormData) {
  const email = String(fd.get("email") ?? "");
  const pw = String(fd.get("password") ?? "");
  const pw2 = String(fd.get("password2") ?? "");
  let next: string;
  try {
    const db = await getDb();
    if (await adminExists(db)) throw new Error("الحساب موجود مسبقاً");
    if (pw !== pw2) throw new Error("كلمتا السر غير متطابقتين");
    await createFirstAdmin(db, email, pw);
    await loginPassword(email, pw);
    next = "/admin/enroll";
  } catch (e) { errTo("/admin/setup", e); }
  redirect(next);
}

export async function loginAction(fd: FormData) {
  let stage: string;
  try {
    stage = await loginPassword(String(fd.get("email") ?? ""), String(fd.get("password") ?? ""));
  } catch (e) { errTo("/admin/login", e); }
  redirect(stage === "enroll" ? "/admin/enroll" : "/admin/verify");
}

export async function verifyAction(fd: FormData) {
  try { await loginTotp(String(fd.get("code") ?? "")); } catch (e) { errTo("/admin/verify", e); }
  redirect("/admin");
}

export async function enrollAction(fd: FormData) {
  try { await confirmTotpEnrollment(String(fd.get("code") ?? "")); } catch (e) { errTo("/admin/enroll", e); }
  redirect("/admin?ok=" + encodeURIComponent("تم تفعيل التحقق بخطوتين ✓"));
}

export async function logoutAction() {
  await logout();
  redirect("/admin/login");
}

export async function changePasswordAction(fd: FormData) {
  try {
    const next = String(fd.get("next") ?? "");
    if (next !== String(fd.get("next2") ?? "")) throw new Error("كلمتا السر غير متطابقتين");
    await changePassword(String(fd.get("current") ?? ""), next);
  } catch (e) { errTo("/admin/settings", e); }
  redirect("/admin/settings?ok=" + encodeURIComponent("تم تغيير كلمة السر ✓"));
}
