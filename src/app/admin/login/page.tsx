import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { adminExists, getAdmin } from "@/server/auth";
import { loginAction } from "@/admin/actions/auth";
import { AuthShell } from "../AuthShell";
import { one, type SP } from "@/admin/ui";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: SP }) {
  if (!(await adminExists(await getDb()))) redirect("/admin/setup");
  if (await getAdmin()) redirect("/admin");
  const sp = await searchParams;
  return (
    <AuthShell title="دخول المالك" err={one(sp.err)}>
      <form action={loginAction} className="space-y-3">
        <label className="block"><span className="lbl">البريد الإلكتروني</span><input className="inp" name="email" type="email" required dir="ltr" autoComplete="username" /></label>
        <label className="block"><span className="lbl">كلمة السر</span><input className="inp" name="password" type="password" required dir="ltr" autoComplete="current-password" /></label>
        <button className="btn w-full">دخول</button>
      </form>
    </AuthShell>
  );
}
