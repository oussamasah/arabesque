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
  const qrs = await Promise.all(tickets.map((t) => (t.token ? QRCode.toDataURL(t.token, { margin: 1, width: 300, errorCorrectionLevel: "M" }) : Promise.resolve(""))));
  // 16 tickets per A4 page (4 × 4), cut along the dashed lines
  const PER_PAGE = 16;
  const pages: number[][] = [];
  for (let i = 0; i < tickets.length; i += PER_PAGE) pages.push(Array.from({ length: Math.min(PER_PAGE, tickets.length - i) }, (_, k) => i + k));
  return (
    <main className="bg-white min-h-screen">
      <style>{`
        @page { size: A4; margin: 6mm; }
        .tk-page { width: 198mm; margin: 0 auto; display: grid; grid-template-columns: repeat(4, 1fr); grid-auto-rows: 70mm; }
        .tk-page + .tk-page { break-before: page; }
        @media print { body { background: #fff !important; } .tk-wrap { padding: 0 !important; } }
      `}</style>
      <div className="no-print flex gap-3 p-4 items-center">
        <PrintButton />
        <span className="muted text-sm">كل ورقة A4 فيها 16 تذكرة. اطبع بحجم 100% (بدون «ملاءمة للصفحة») ثم قصّ على الخطوط. التذاكر المستعملة أو الملغاة مشطوبة.</span>
      </div>
      <div className="tk-wrap">
        {pages.map((idx, pi) => (
          <div key={pi} className="tk-page">
            {idx.map((i) => {
              const t = tickets[i];
              return (
                <div key={t.id} className="border border-dashed border-gray-400 text-center relative flex flex-col items-center justify-center overflow-hidden" style={{ breakInside: "avoid", padding: "2mm" }}>
                  <div className="font-bold text-[11px] leading-tight">{s.business_name}</div>
                  <div className="text-[11px] leading-tight">{t.customerName}</div>
                  <div className="text-[10px] font-bold leading-tight">{sheet.type === "credit" ? "تذكرة كريدي" : "تذكرة مجانية"}{sheet.maxAmountMillimes ? ` — سقف ${formatDT(sheet.maxAmountMillimes)}` : ""}</div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {qrs[i] && <img src={qrs[i]} alt="" style={{ width: "34mm", height: "34mm" }} className="my-1" />}
                  <div className="font-mono text-[15px] tracking-widest leading-tight" dir="ltr">{t.shortCode.slice(0, 4)}-{t.shortCode.slice(4)}</div>
                  <div className="text-[8px] text-gray-500" dir="ltr">#{sheet.id}-{String(i + 1).padStart(3, "0")} · {t.id.slice(0, 8)}</div>
                  {t.status !== "issued" && <div className="absolute inset-0 bg-white/80 flex items-center justify-center text-xl font-black text-red-700">{t.status === "used" ? "مستعملة" : "ملغاة"}</div>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </main>
  );
}
