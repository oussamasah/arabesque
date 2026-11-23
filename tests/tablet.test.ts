import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sha256Hex as jsSha } from "@/lib/sha256";
import { canonicalJson, hashInput, type EventEnvelope } from "@/lib/canonical";
import { computeEventHash } from "@/server/sync";

describe("tablet hashing", () => {
  it("pure-JS SHA-256 equals Node crypto (incl. Arabic, empty, block edges)", () => {
    for (const s of ["", "abc", "قهوة ☕", "a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(1000)]) {
      expect(jsSha(s)).toBe(crypto.createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });
  it("tablet and server compute the same event hash", () => {
    const env: Omit<EventEnvelope, "hash"> = {
      client_event_id: "6b1c2a5e-8d5e-4b8e-9c3a-1f2e3d4c5b6a", device_id: "0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a", seq: 7,
      type: "order.create", client_ts: 1763628000000, clock_offset_ms: -1200,
      payload: { items: [{ product_id: 3, qty: 2 }], payment: "cash" }, prev_hash: "ab".repeat(32),
    };
    const tablet = jsSha((env.prev_hash ?? "") + canonicalJson(env));
    expect(tablet).toBe(computeEventHash(env));
    expect(hashInput(env)).toBe((env.prev_hash ?? "") + canonicalJson(env));
  });
});

describe("10. worker app: no costs/stock/admin money code in the tablet (prices only from config, Owner setting)", () => {
  const files = ["src/pos/PosApp.tsx", "src/pos/store.ts", "src/pos/sync.ts", "src/pos/Scanner.tsx", "src/pos/CacheAssets.tsx", "src/app/pos/page.tsx"];
  it.each(files)("%s contains no cost or stock fields", (f) => {
    const src = fs.readFileSync(path.join(process.cwd(), f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // code only, not comments
    expect(src).not.toMatch(/formatDT|total_|cost|stock_qty|qty_base|unitPrice|priceMillimes/i);
  });
  it("the built /pos client bundle does not contain admin/money code (if built)", () => {
    const dir = path.join(process.cwd(), ".next", "static", "chunks", "app", "pos");
    if (!fs.existsSync(dir)) return;
    const all = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".js"))
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
    expect(all).not.toMatch(/priceMillimes|unitPrice|formatDT|costPerBase/);
  });
});
