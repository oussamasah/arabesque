import QRCode from "qrcode";
import { getDb } from "@/db";
import { requireAdmin } from "@/server/auth";
import { sheetForPrint } from "@/server/tickets";
import { getSettings } from "@/server/settings";
import { audit } from "@/server/audit";
import { formatDT } from "@/lib/money";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";

/** Printable A4 sheet of cut-out QR tickets. QR content = the random 128-bit token only (never a name or a number). */
export default async function PrintSheet({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  const { id } = await params;
  const db = await getDb();
  const s = await getSettings(db);
  const { sheet, tickets } = await sheetForPrint(db, Number(id));
  await audit(db, admin.email, "ticket.print_sheet", "ticket_sheet", sheet.id, null, null);
  const qrs = await Promise.all(tickets.map((t) => (t.token ? QRCode.toDataURL(t.token, { margin: 1, width: 220, errorCorrectionLevel: "M" }) : Promise.resolve(""))));
  return (
    <main className="p-4 bg-white min-h-screen">
      <div className="no-print flex gap-3 mb-4 items-center">
        <PrintButton />
        <span className="muted text-sm">قصّ التذاكر وسلّمها للزبون. التذاكر المستعملة أو الملغاة مشطوبة.</span>
      </div>
      <div className="grid grid-cols-3 gap-0 print:gap-0" style={{ width: "100%" }}>
        {tickets.map((t, i) => (
          <div key={t.id} className="border border-dashed border-gray-400 p-3 text-center relative" style={{ breakInside: "avoid" }}>
            <div className="font-bold text-sm">{s.business_name}</div>
            <div className="text-sm">{t.customerName}</div>
            <div className="text-xs font-bold">{sheet.type === "credit" ? "تذكرة كريدي" : "تذكرة مجانية"}{sheet.maxAmountMillimes ? ` — سقف ${formatDT(sheet.maxAmountMillimes)}` : ""}</div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {qrs[i] && <img src={qrs[i]} alt="" width={150} height={150} className="mx-auto my-1" />}
            <div className="font-mono text-lg tracking-widest" dir="ltr">{t.shortCode.slice(0, 4)}-{t.shortCode.slice(4)}</div>
            <div className="text-[9px] text-gray-500" dir="ltr">#{sheet.id}-{String(i + 1).padStart(3, "0")} · {t.id.slice(0, 8)}</div>
            {t.status !== "issued" && <div className="absolute inset-0 bg-white/80 flex items-center justify-center text-2xl font-black text-red-700">{t.status === "used" ? "مستعملة" : "ملغاة"}</div>}
          </div>
        ))}
      </div>
    </main>
  );
}
