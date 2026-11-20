import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { alerts, auditLog } from "@/db/schema";
import type { Exec } from "@/db";

export async function audit(
  db: Exec, actor: string, action: string, entity: string | null, entityId: string | number | null,
  before: unknown, after: unknown, ip?: string | null,
) {
  await db.insert(auditLog).values({
    actor, action, entity, entityId: entityId === null ? null : String(entityId),
    before: before === undefined ? null : (JSON.parse(JSON.stringify(before ?? null)) as object),
    after: after === undefined ? null : (JSON.parse(JSON.stringify(after ?? null)) as object),
    ip: ip ?? null,
  });
}

export type Severity = "info" | "warn" | "critical";

export interface AlertInput {
  severity: Severity; type: string; message: string; ref?: string | null;
  dedupeKey?: string | null; businessDay?: string | null; shift?: string | null;
}

/** Raise an alert. With a dedupeKey, a second alert is not created while one is still open (not acknowledged, not resolved). */
export async function raiseAlert(db: Exec, a: AlertInput): Promise<boolean> {
  if (a.dedupeKey) {
    const open = await db.select({ id: alerts.id }).from(alerts)
      .where(and(eq(alerts.dedupeKey, a.dedupeKey), isNull(alerts.acknowledgedAt), isNull(alerts.resolvedAt)))
      .limit(1);
    if (open.length) return false;
  }
  await db.insert(alerts).values({
    severity: a.severity, type: a.type, message: a.message, ref: a.ref ?? null,
    dedupeKey: a.dedupeKey ?? null, businessDay: a.businessDay ?? null, shift: a.shift ?? null,
  });
  return true;
}

export async function resolveAlerts(db: Exec, dedupeKey: string) {
  await db.update(alerts).set({ resolvedAt: new Date() })
    .where(and(eq(alerts.dedupeKey, dedupeKey), isNull(alerts.resolvedAt), isNull(alerts.acknowledgedAt)));
}

export const ALERT_TYPE_AR: Record<string, string> = {
  low_stock: "مخزون منخفض",
  stock_running_out: "المخزون سينفد قريباً",
  negative_stock: "مخزون سالب",
  low_tickets: "تذاكر الزبون قاربت على النفاد",
  negative_variance: "نقص في الجرد",
  margin_critical: "الهامش مستهلك بالكامل",
  margin_repeated: "استهلاك هامش مرتفع متكرر",
  variance_value: "قيمة فرق كبيرة",
  piece_variance: "نقص في منتج بالقطعة",
  cash_variance: "فرق في الكاش",
  ticket_mismatch: "عدد التذاكر لا يطابق",
  ticket_reuse_attempt: "محاولة استعمال تذكرة مستعملة",
  ticket_conflict: "تعارض تذكرة (استعمال مزدوج)",
  ticket_invalid: "تذكرة غير صالحة في طلب",
  over_ticket_limit: "تجاوز سقف التذكرة",
  void_spike: "إلغاءات كثيرة",
  sequence_gap: "فجوة في تسلسل الطلبات",
  sequence_regression: "رجوع في تسلسل الجهاز",
  hash_chain_broken: "سلسلة التحقق مكسورة",
  hash_invalid: "توقيع حدث غير صالح",
  device_silent: "الجهاز لم يزامن منذ مدة",
  no_orders_busy_hour: "لا طلبات في ساعة ذروة",
  clock_skew: "فرق كبير في ساعة الجهاز",
  late_sync: "مزامنة متأخرة",
  unknown_product: "منتج غير معروف",
  inactive_product: "منتج غير مفعّل في طلب",
  no_price: "منتج بدون سعر",
  login_lockout: "قفل تسجيل الدخول",
  rejected_event: "حدث مرفوض من الجهاز",
  unpaid_order: "طلب غير مدفوع منذ مدة",
  unpaid_shift: "طلبات غير مدفوعة عند تسليم الشيفت",
  unpaid_loss: "طلب سُجّل غير مدفوع (خسارة)",
  double_payment: "محاولة دفع ثانية",
  pay_after_void: "دفع بعد الإلغاء",
  worker_owed: "مبلغ على العامل (طلبات غير مدفوعة)",
};
