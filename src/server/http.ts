import "server-only";

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function readJson(req: Request, maxBytes = 512_000): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) throw new Error("payload too large");
  return JSON.parse(text);
}
