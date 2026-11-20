import "server-only";
import { eq } from "drizzle-orm";
import { settings } from "@/db/schema";
import type { Exec } from "@/db";

export interface RiskWeights {
  cash_variance: number; ticket_mismatch: number; margin_critical: number; margin_warn: number;
  void_spike: number; integrity: number; negative_piece_variance: number; unpaid_orders: number;
}

export interface Settings {
  business_name: string;
  morning_start_hour: number;
  evening_start_hour: number;
  default_worker_morning: string;
  default_worker_evening: string;
  week_start: "monday";
  max_offline_hours: number;
  future_tolerance_min: number;
  clock_skew_threshold_ms: number;
  low_tickets_threshold: number;
  consumption_window_days: number;
  reorder_days_ahead: number;
  device_silent_hours: number;
  unpaid_alert_hours: number;
  busy_hours: number[];
  margin_critical_pct: number;
  margin_warn_pct: number;
  margin_warn_consecutive: number;
  variance_value_critical_millimes: number;
  void_spike_count: number;
  risk_weights: RiskWeights;
  risk_yellow_at: number;
  risk_red_at: number;
  telegram_chat_id: string;
  report_email: string;
}

export const DEFAULT_SETTINGS: Settings = {
  business_name: "Café Arabesque",
  morning_start_hour: 6,
  evening_start_hour: 15,
  default_worker_morning: "",
  default_worker_evening: "",
  week_start: "monday",
  max_offline_hours: 72,
  future_tolerance_min: 5,
  clock_skew_threshold_ms: 120_000,
  low_tickets_threshold: 5,
  consumption_window_days: 7,
  reorder_days_ahead: 3,
  device_silent_hours: 6,
  unpaid_alert_hours: 3,
  busy_hours: [],
  margin_critical_pct: 100,
  margin_warn_pct: 90,
  margin_warn_consecutive: 3,
  variance_value_critical_millimes: 5000,
  void_spike_count: 3,
  risk_weights: {
    cash_variance: 2, ticket_mismatch: 2, margin_critical: 3, margin_warn: 1,
    void_spike: 1, integrity: 3, negative_piece_variance: 2, unpaid_orders: 1,
  },
  risk_yellow_at: 1,
  risk_red_at: 4,
  telegram_chat_id: "",
  report_email: "",
};

export async function getSettings(db: Exec): Promise<Settings> {
  const rows = await db.select().from(settings);
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS, risk_weights: { ...DEFAULT_SETTINGS.risk_weights } };
  for (const r of rows) {
    if (r.key === "risk_weights") out.risk_weights = { ...DEFAULT_SETTINGS.risk_weights, ...(r.value as object) };
    else if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
  }
  return out as unknown as Settings;
}

export async function setSetting(db: Exec, key: keyof Settings, value: unknown) {
  const existing = await db.select().from(settings).where(eq(settings.key, key));
  if (existing.length) await db.update(settings).set({ value: value as object }).where(eq(settings.key, key));
  else await db.insert(settings).values({ key, value: value as object });
}
