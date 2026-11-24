CREATE TABLE "workers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name_ar" text NOT NULL,
	"daily_wage_millimes" bigint NOT NULL,
	"start_day" date NOT NULL,
	"end_day" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "worker_days" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"worker_id" bigint NOT NULL,
	"day" date NOT NULL,
	"halves" integer NOT NULL,
	"wage_millimes" bigint NOT NULL
);--> statement-breakpoint
CREATE TABLE "worker_advances" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"worker_id" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"business_day" date NOT NULL,
	"amount_millimes" bigint NOT NULL,
	"note" text,
	"created_by" text,
	"cancelled_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "wage_payments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"worker_id" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"week_start" date NOT NULL,
	"amount_millimes" bigint NOT NULL,
	"note" text,
	"created_by" text,
	"cancelled_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "worker_days" ADD CONSTRAINT "worker_days_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_advances" ADD CONSTRAINT "worker_advances_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wage_payments" ADD CONSTRAINT "wage_payments_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_days_uq" ON "worker_days" USING btree ("worker_id","day");
