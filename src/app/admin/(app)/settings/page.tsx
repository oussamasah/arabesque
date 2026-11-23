import { getDb } from "@/db";
import { getSettings } from "@/server/settings";
import { changePasswordAction } from "@/admin/actions/auth";
import { settingsAction, testReportAction } from "@/admin/actions/main";
import { Back, Flash, PageTitle, type SP } from "@/admin/ui";
import { millimesToInput } from "@/lib/money";

export const dynamic = "force-dynamic";

function N({ name, label, value, hint }: { name: string; label: string; value: number; hint?: string }) {
  return (
    <label className="block"><span className="lbl">{label}</span><input className="inp" name={name} type="number" defaultValue={value} dir="ltr" />{hint && <span className="muted text-xs">{hint}</span>}</label>
  );
}

const RW_AR: Record<string, string> = {
  cash_variance: "فرق كاش", ticket_mismatch: "عدم تطابق التذاكر", margin_critical: "هامش ≥ الحد الحرج", margin_warn: "هامش ≥ حد التحذير",
  void_spike: "إلغاءات كثيرة", integrity: "مشاكل سلامة البيانات (تسلسل/ساعة)", negative_piece_variance: "نقص منتجات بالقطعة", unpaid_orders: "طلبات غير مدفوعة",
};

export default async function SettingsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const s = await getSettings(await getDb());
  const telegramReady = !!process.env.TELEGRAM_BOT_TOKEN;
  return (
    <>
      <Flash sp={sp} />
      <PageTitle title="الإعدادات" />
      <form action={settingsAction} className="grid lg:grid-cols-3 gap-4 mb-6">
        <Back value="/admin/settings" />
        <section className="card space-y-2">
          <h2 className="h2">عام والشيفتات</h2>
          <label className="block"><span className="lbl">اسم المقهى</span><input className="inp" name="business_name" defaultValue={s.business_name} /></label>
          <N name="morning_start_hour" label="بداية الصباحية (ساعة)" value={s.morning_start_hour} />
          <N name="evening_start_hour" label="بداية المسائية (ساعة)" value={s.evening_start_hour} />
          <label className="block"><span className="lbl">ساعات الذروة (تنبيه إن لم يُسجَّل أي طلب) مثال: 9,10,17,18</span><input className="inp" name="busy_hours" defaultValue={s.busy_hours.join(",")} dir="ltr" /></label>
          <label className="flex gap-2 items-center"><input type="checkbox" name="tablet_show_prices" defaultChecked={s.tablet_show_prices} /> إظهار الأسعار والمجموع على التابلت</label>
          <h2 className="h2 pt-2">المخزون والتذاكر</h2>
          <N name="reorder_days_ahead" label="تنبيه الشراء قبل النفاد بـ (أيام)" value={s.reorder_days_ahead} />
          <N name="consumption_window_days" label="فترة حساب متوسط الاستهلاك (أيام)" value={s.consumption_window_days} />
          <N name="low_tickets_threshold" label="تنبيه عند بقاء (تذاكر للزبون)" value={s.low_tickets_threshold} />
        </section>
        <section className="card space-y-2">
          <h2 className="h2">حدود التنبيه</h2>
          <N name="margin_critical_pct" label="الهامش المستعمل — حرج (%)" value={s.margin_critical_pct} />
          <N name="margin_warn_pct" label="الهامش المستعمل — تحذير (%)" value={s.margin_warn_pct} />
          <N name="margin_warn_consecutive" label="… لعدد شيفتات متتالية" value={s.margin_warn_consecutive} />
          <label className="block"><span className="lbl">قيمة فرق الجرد الحرجة (DT)</span><input className="inp" name="variance_value_critical" defaultValue={millimesToInput(s.variance_value_critical_millimes)} dir="ltr" /></label>
          <N name="void_spike_count" label="عدد الإلغاءات في شيفت للتنبيه" value={s.void_spike_count} />
          <N name="device_silent_hours" label="الجهاز لم يزامن منذ (ساعات)" value={s.device_silent_hours} />
          <N name="unpaid_alert_hours" label="تنبيه طلب غير مدفوع بعد (ساعات)" value={s.unpaid_alert_hours} />
          <N name="max_offline_hours" label="مزامنة متأخرة بعد (ساعات)" value={s.max_offline_hours} />
          <N name="clock_skew_threshold_s" label="تغيّر ساعة الجهاز (ثوانٍ)" value={s.clock_skew_threshold_ms / 1000} />
          <N name="future_tolerance_min" label="سماحية الوقت المستقبلي (دقائق)" value={s.future_tolerance_min} />
        </section>
        <section className="card space-y-2">
          <h2 className="h2">نقاط خطورة الشيفت</h2>
          {Object.entries(s.risk_weights).map(([k, v]) => <N key={k} name={`rw_${k}`} label={RW_AR[k] ?? k} value={v} />)}
          <N name="risk_yellow_at" label="أصفر ابتداءً من (نقاط)" value={s.risk_yellow_at} />
          <N name="risk_red_at" label="أحمر ابتداءً من (نقاط)" value={s.risk_red_at} />
          <h2 className="h2 pt-2">التقرير اليومي</h2>
          <label className="block"><span className="lbl">معرّف محادثة تيليغرام (chat id)</span><input className="inp" name="telegram_chat_id" defaultValue={s.telegram_chat_id} dir="ltr" /></label>
          <p className="muted text-xs">{telegramReady ? "TELEGRAM_BOT_TOKEN مضبوط ✓" : "أضف TELEGRAM_BOT_TOKEN في متغيرات البيئة لتفعيل الإرسال."}</p>
          <label className="block"><span className="lbl">بريد التقرير (للاستعمال لاحقاً)</span><input className="inp" name="report_email" defaultValue={s.report_email} dir="ltr" /></label>
        </section>
        <div className="lg:col-span-3"><button className="btn">حفظ الإعدادات</button></div>
      </form>
      <div className="grid lg:grid-cols-2 gap-4">
        <section className="card">
          <h2 className="h2 mb-3">تغيير كلمة السر</h2>
          <form action={changePasswordAction} className="space-y-2">
            <input className="inp" type="password" name="current" placeholder="كلمة السر الحالية" required dir="ltr" autoComplete="current-password" />
            <input className="inp" type="password" name="next" placeholder="الجديدة (10 أحرف+، حروف وأرقام)" required minLength={10} dir="ltr" autoComplete="new-password" />
            <input className="inp" type="password" name="next2" placeholder="تأكيد الجديدة" required minLength={10} dir="ltr" autoComplete="new-password" />
            <button className="btn">تغيير</button>
          </form>
        </section>
        <section className="card">
          <h2 className="h2 mb-3">إرسال تقرير تجريبي</h2>
          <form action={testReportAction}><Back value="/admin/settings" /><button className="btn btn-ghost" disabled={!telegramReady}>إرسال تقرير اليوم إلى تيليغرام</button></form>
          <p className="muted text-xs mt-2">الإرسال الآلي اليومي: استدعِ <code dir="ltr">/api/cron/daily</code> مع المفتاح السري (Vercel Cron أو مجدول المهام).</p>
        </section>
      </div>
    </>
  );
}
