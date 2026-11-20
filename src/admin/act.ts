import "server-only";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb, type Tx } from "@/db";
import { clientIp, requireAdmin } from "@/server/auth";
import { parseDT } from "@/lib/money";
import { parseTunisLocal } from "@/lib/time";

export class Form {
  constructor(private fd: FormData) {}
  str(name: string, required = false): string {
    const v = String(this.fd.get(name) ?? "").trim();
    if (required && !v) throw new Error(`الحقل مطلوب: ${name}`);
    return v;
  }
  opt(name: string): string | null { const v = this.str(name); return v || null; }
  int(name: string, def?: number): number {
    const v = this.str(name);
    if (!v) { if (def !== undefined) return def; throw new Error(`رقم مطلوب: ${name}`); }
    if (!/^-?\d+$/.test(v)) throw new Error(`رقم صحيح غير صالح: ${v}`);
    return Number(v);
  }
  optInt(name: string): number | null { const v = this.str(name); return v ? this.int(name) : null; }
  money(name: string): number { return parseDT(this.str(name, true)); }
  optMoney(name: string): number | null { const v = this.str(name); return v ? parseDT(v) : null; }
  bool(name: string): boolean { const v = this.fd.get(name); return v === "on" || v === "true" || v === "1"; }
  time(name: string): Date { const v = this.str(name); return v ? parseTunisLocal(v) : new Date(); }
  all(name: string): string[] { return this.fd.getAll(name).map((x) => String(x)); }
  raw() { return this.fd; }
}

function withParam(path: string, key: string, value: string) {
  const [p, q = ""] = path.split("?");
  const sp = new URLSearchParams(q);
  sp.delete("ok"); sp.delete("err");
  sp.set(key, value);
  return `${p}?${sp.toString()}`;
}

function safeBack(v: FormDataEntryValue | null): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/admin") && !s.startsWith("//") ? s : "/admin";
}

function isRedirect(e: unknown) {
  return typeof e === "object" && e !== null && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_REDIRECT");
}

export interface Ctx { db: Tx; actor: string; ip: string; f: Form }

/**
 * Run an admin mutation: requires a full (password + 2FA) session, runs inside a DB transaction,
 * then redirects back with ?ok= or ?err=. `fn` may return a different destination path.
 */
export async function run(fd: FormData, fn: (c: Ctx) => Promise<string | void>, okMsg = "تم الحفظ ✓") {
  const admin = await requireAdmin();
  const back = safeBack(fd.get("_back"));
  const ip = await clientIp();
  let dest: string;
  try {
    const db = await getDb();
    const res = await db.transaction((tx) => fn({ db: tx, actor: admin.email, ip, f: new Form(fd) }));
    dest = withParam(typeof res === "string" ? res : back, "ok", okMsg);
  } catch (e) {
    if (isRedirect(e)) throw e;
    console.error(e);
    dest = withParam(back, "err", (e as Error).message || "خطأ");
  }
  revalidatePath("/admin", "layout");
  redirect(dest);
}
