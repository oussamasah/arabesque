ALTER TABLE "orders" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paid_business_day" date;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paid_shift" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "table_ref" text;--> statement-breakpoint
CREATE INDEX "orders_paid_day_shift" ON "orders" USING btree ("paid_business_day","paid_shift");--> statement-breakpoint
UPDATE "orders" SET "paid_at" = "effective_ts", "paid_business_day" = "business_day", "paid_shift" = "shift" WHERE "payment_type" IN ('cash','ticket');
