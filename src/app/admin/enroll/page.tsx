import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { getDb } from "@/db";
import { getAdmin, getPendingSession, startTotpEnrollment } from "@/server/auth";
import { decrypt } from "@/server/crypto";
import { enrollAction } from "@/admin/actions/auth";
import { getSettings } from "@/server/settings";
import { AuthShell } from "../AuthShell";
import { one, type SP } from "@/admin/ui";

export const dynamic = "force-dynamic";

export default async function EnrollPage({ searchParams }: { searchParams: SP }) {
  const pending = await getPendingSession();
  const full = await getAdmin();
  if (full) redirect("/admin"); // already enrolled (2FA reset is done from settings)
  if (!pending) redirect("/admin/login");
  if (pending.admin.totpEnabled) redirect("/admin/verify");
  const db = await getDb();
  const secret = pending.admin.totpSecretEnc ? decrypt(pending.admin.totpSecretEnc) : await startTotpEnrollment(db, pending.admin.id);
  const s = await getSettings(db);
  const issuer = encodeURIComponent(s.business_name || "Cafe POS");
  const uri = `otpauth://totp/${issuer}:${encodeURIComponent(pending.admin.email)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
  const sp = await searchParams;
  return (
    <AuthShell title="تفعيل التحقق بخطوتين" err={one(sp.err)}>
      <ol className="list-decimal pr-5 space-y-1 text-sm mb-4">
        <li>ثبّت تطبيق Google Authenticator أو Microsoft Authenticator على هاتفك.</li>
        <li>امسح هذا الرمز (أو اكتب المفتاح يدوياً).</li>
        <li>أدخل الرمز المكوّن من 6 أرقام.</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qr} alt="QR" className="mx-auto mb-2" width={240} height={240} />
      <p className="text-center font-mono text-sm break-all mb-4" dir="ltr">{secret.match(/.{1,4}/g)?.join(" ")}</p>
      <form action={enrollAction} className="space-y-3">
        <input className="inp text-center text-3xl tracking-[0.5em]" name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} required dir="ltr" autoComplete="one-time-code" />
        <button className="btn w-full">تفعيل</button>
      </form>
    </AuthShell>
  );
}
