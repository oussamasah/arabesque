import "server-only";
import crypto from "node:crypto";
import { getSecrets } from "./crypto";

export function cronAuthorized(req: Request): boolean {
  const secret = getSecrets().cronSecret;
  if (!secret) return false;
  const url = new URL(req.url);
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/, "") ?? url.searchParams.get("key") ?? "";
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
