ALTER TABLE "cash_counts" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cash_counts" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "cash_counts" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_prices" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_prices" ADD COLUMN "voided_by" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "stock_items" ADD COLUMN "deleted_at" timestamp with time zone;