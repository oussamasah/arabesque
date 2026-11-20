import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { adminExists } from "@/server/auth";
import { setupAction } from "@/admin/actions/auth";
import { AuthShell } from "../AuthShell";
import { one, type SP } from "@/admin/ui";

export const dynamic = "force-dynamic";

export default async function SetupPage({ searchParams }: { searchParams: SP }) {
  if (await adminExists(await getDb())) redirect("/admin/login");
  const sp = await searchParams;
  return (
    <AuthShell title="إنشاء حساب المالك" err={one(sp.err)}>
      <p className="muted text-sm mb-4">أول تشغيل: أنشئ حساب صاحب المقهى. بعدها ستفعّل التحقق بخطوتين (Google Authenticator).</p>
      <form action={setupAction} className="space-y-3">
        <label className="block"><span className="lbl">البريد الإلكتروني</span><input className="inp" name="email" type="email" required dir="ltr" autoComplete="username" /></label>
        <label className="block"><span className="lbl">كلمة السر (10 أحرف على الأقل، حروف وأرقام)</span><input className="inp" name="password" type="password" required minLength={10} dir="ltr" autoComplete="new-password" /></label>
        <label className="block"><span className="lbl">تأكيد كلمة السر</span><input className="inp" name="password2" type="password" required minLength={10} dir="ltr" autoComplete="new-password" /></label>
        <button className="btn w-full">إنشاء الحساب</button>
      </form>
    </AuthShell>
  );
}
