CREATE TABLE "admin_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"admin_id" bigint NOT NULL,
	"stage" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	CONSTRAINT "admin_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admins_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"severity" text NOT NULL,
	"type" text NOT NULL,
	"ref" text,
	"dedupe_key" text,
	"business_day" date,
	"shift" text,
	"message" text NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "cash_counts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"business_day" date NOT NULL,
	"shift" text NOT NULL,
	"expected_cash_millimes" bigint NOT NULL,
	"counted_cash_millimes" bigint NOT NULL,
	"variance_millimes" bigint NOT NULL,
	"tickets_expected" integer NOT NULL,
	"tickets_in_drawer" integer NOT NULL,
	"counted_by" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"customer_id" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"business_day" date NOT NULL,
	"type" text NOT NULL,
	"amount_millimes" bigint NOT NULL,
	"order_id" uuid,
	"ticket_id" uuid,
	"note" text,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"note" text,
	"low_tickets_threshold" integer,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"paired_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_clock_offset_ms" bigint,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"last_hash" text,
	"app_version" text,
	"pending_reported" integer
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"label" text NOT NULL,
	"amount_millimes" bigint NOT NULL,
	"recurrence" text NOT NULL,
	"start_day" date NOT NULL,
	"end_day" date,
	"is_purchase" boolean DEFAULT false NOT NULL,
	"purchase_ref" bigint,
	"paid_from" text DEFAULT 'owner' NOT NULL,
	"paid_at" timestamp with time zone,
	"invoice_ref" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"success" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" bigint NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_millimes" bigint NOT NULL,
	"unit_cost_millimes" numeric(18, 3) NOT NULL,
	"recipe_version_id" bigint
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid,
	"device_seq" bigint NOT NULL,
	"order_label" text NOT NULL,
	"client_ts" timestamp with time zone NOT NULL,
	"effective_ts" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"business_day" date NOT NULL,
	"shift" text NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"payment_type" text NOT NULL,
	"ticket_id" uuid,
	"total_millimes" bigint NOT NULL,
	"cost_millimes" numeric(18, 3) NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"void_reason" text,
	"voided_by" text,
	"voided_at" timestamp with time zone,
	"review_note" text
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"device_name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "product_prices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"product_id" bigint NOT NULL,
	"price_millimes" bigint NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name_ar" text NOT NULL,
	"name_fr" text,
	"category" text,
	"color" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_lines" (
	"recipe_version_id" bigint NOT NULL,
	"stock_item_id" bigint NOT NULL,
	"qty_base" bigint NOT NULL,
	"real_qty_base" numeric(18, 3) NOT NULL,
	CONSTRAINT "recipe_lines_recipe_version_id_stock_item_id_pk" PRIMARY KEY("recipe_version_id","stock_item_id")
);
--> statement-breakpoint
CREATE TABLE "recipe_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"product_id" bigint NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "roster" (
	"business_day" date NOT NULL,
	"shift" text NOT NULL,
	"worker_name" text NOT NULL,
	CONSTRAINT "roster_business_day_shift_pk" PRIMARY KEY("business_day","shift")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_cost_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"stock_item_id" bigint NOT NULL,
	"cost_per_base" numeric(24, 10) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"purchase_movement_id" bigint
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"business_day" date NOT NULL,
	"evaluated_shift" text NOT NULL,
	"handover" text NOT NULL,
	"stock_item_id" bigint NOT NULL,
	"theoretical_base" bigint NOT NULL,
	"counted_base" bigint NOT NULL,
	"variance_base" bigint NOT NULL,
	"expected_surplus_base" numeric(18, 3) NOT NULL,
	"margin_used_pct" numeric(10, 2),
	"value_millimes" numeric(18, 3),
	"units_sold" bigint DEFAULT 0 NOT NULL,
	"counted_by" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name_ar" text NOT NULL,
	"kind" text NOT NULL,
	"qty_base" bigint DEFAULT 0 NOT NULL,
	"cost_per_base" numeric(24, 10) DEFAULT '0' NOT NULL,
	"min_qty_base" bigint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"stock_item_id" bigint NOT NULL,
	"delta_base" bigint NOT NULL,
	"type" text NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" uuid,
	"seq" bigint NOT NULL,
	"client_event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"reason" text,
	CONSTRAINT "sync_events_client_event_id_unique" UNIQUE("client_event_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_sheets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"customer_id" bigint NOT NULL,
	"type" text NOT NULL,
	"ticket_count" integer NOT NULL,
	"max_amount_millimes" bigint,
	"issued_at" timestamp with time zone NOT NULL,
	"issued_by" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sheet_id" bigint,
	"token_hash" text NOT NULL,
	"token_enc" text,
	"short_code" text NOT NULL,
	"short_code_hash" text NOT NULL,
	"type" text NOT NULL,
	"customer_id" bigint,
	"customer_name" text NOT NULL,
	"max_amount_millimes" bigint,
	"status" text DEFAULT 'issued' NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"issued_by" text,
	"note" text,
	"used_order_id" uuid,
	"used_at" timestamp with time zone,
	"used_device_id" uuid,
	CONSTRAINT "tickets_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "tickets_short_code_unique" UNIQUE("short_code"),
	CONSTRAINT "tickets_short_code_hash_unique" UNIQUE("short_code_hash")
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_recipe_version_id_recipe_versions_id_fk" FOREIGN KEY ("recipe_version_id") REFERENCES "public"."recipe_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_cost_history" ADD CONSTRAINT "stock_cost_history_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_sheets" ADD CONSTRAINT "ticket_sheets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_sheet_id_ticket_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."ticket_sheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_dedupe" ON "alerts" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "alerts_ts" ON "alerts" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_ts" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "login_attempts_key_ts" ON "login_attempts" USING btree ("key","ts");--> statement-breakpoint
CREATE INDEX "order_items_order" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_device_seq" ON "orders" USING btree ("device_id","device_seq");--> statement-breakpoint
CREATE INDEX "orders_day_shift" ON "orders" USING btree ("business_day","shift");--> statement-breakpoint
CREATE INDEX "orders_effective" ON "orders" USING btree ("effective_ts");--> statement-breakpoint
CREATE INDEX "product_prices_pid_eff" ON "product_prices" USING btree ("product_id","effective_from");--> statement-breakpoint
CREATE INDEX "recipe_versions_pid_eff" ON "recipe_versions" USING btree ("product_id","effective_from");--> statement-breakpoint
CREATE INDEX "stock_cost_hist_item_eff" ON "stock_cost_history" USING btree ("stock_item_id","effective_from");--> statement-breakpoint
CREATE INDEX "stock_counts_item_ts" ON "stock_counts" USING btree ("stock_item_id","ts");--> statement-breakpoint
CREATE INDEX "stock_movements_item_ts" ON "stock_movements" USING btree ("stock_item_id","ts");--> statement-breakpoint
CREATE INDEX "stock_movements_ref" ON "stock_movements" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "tickets_customer_status" ON "tickets" USING btree ("customer_id","status");