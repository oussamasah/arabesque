import { redirect } from "next/navigation";
import { getPendingSession } from "@/server/auth";
import { verifyAction } from "@/admin/actions/auth";
import { AuthShell } from "../AuthShell";
import { one, type SP } from "@/admin/ui";

export const dynamic = "force-dynamic";

export default async function VerifyPage({ searchParams }: { searchParams: SP }) {
  const s = await getPendingSession();
  if (!s) redirect("/admin/login");
  if (!s.admin.totpEnabled) redirect("/admin/enroll");
  const sp = await searchParams;
  return (
    <AuthShell title="رمز التحقق" err={one(sp.err)}>
      <p className="muted text-sm mb-4">أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة.</p>
      <form action={verifyAction} className="space-y-3">
        <input className="inp text-center text-3xl tracking-[0.5em]" name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoFocus dir="ltr" autoComplete="one-time-code" />
        <button className="btn w-full">تحقق</button>
      </form>
    </AuthShell>
  );
}
