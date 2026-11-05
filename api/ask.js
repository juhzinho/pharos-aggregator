import { ask, toJson } from "../lib/ask.js";
import { VENUES } from "../lib/contracts.js";

// GET /api/ask?q=<request>[&down=<venue>,…] — live on Pharos Pacific. `down` injects an outage into that venue's
// reads for the demo (reported as injected); the other venues are read normally.
export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 300);
  const send = (status, body) => res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(toJson(body));
  if (q.length < 3) return send(400, { ok: false, error: "Ask something, e.g. “Deposit 10,000 USDC” or “Positions of 0x…”." });
  const down = (url.searchParams.get("down") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = down.filter((id) => !VENUES.some((v) => v.id === id));
  if (unknown.length) return send(400, { ok: false, error: `unknown venue: ${unknown.join(", ")}` });
  if (down.length >= VENUES.length) return send(400, { ok: false, error: "leave at least one venue up" });
  try {
    const report = await ask(q, { faults: Object.fromEntries(down.map((id) => [id, "down"])) });
    return send(200, { ok: true, report });
  } catch (e) {
    const busy = /unreachable|timeout|ECONN|fetch failed/i.test(e.message);
    return send(busy ? 503 : 500, { ok: false, error: busy ? "The Pharos Pacific RPC is not answering right now. Try again in a minute." : e.message });
  }
}
