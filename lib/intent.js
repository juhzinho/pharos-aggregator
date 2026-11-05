import { getAddress } from "viem";

// Plain requests → one of four operations. English and Portuguese. Anything unclear is refused, never guessed:
// a request that could move funds must name its amount, and a withdrawal its wallet.

const ADDRESS = /0x[0-9a-fA-F]{40}/;
const AMOUNT = /(\d[\d.,_]*)\s*(k|m|mil|milh(?:ão|ao|ões|oes))?(?![\w])/i;
const PORTUGUESE = /\b(depositar|deposite|aplicar|aplique|investir|invista|colocar|coloque|emprestar|sacar|saque|retirar|retire|resgatar|resgate|posi(ç|c)|carteira|saldo|taxas?|rendimento|melhor|quanto|tudo|onde|qual)\b/i;

/**
 * "5,000" / "5.000" mean different things in English and Portuguese, and here a misread moves 1000× the money.
 * The request's language decides: English → "," groups thousands, "." is decimal; Portuguese → the reverse.
 */
export function normalizeNumber(raw, lang) {
  const s = raw.replace(/_/g, "").replace(/[.,]$/, "");
  const [group, decimal] = lang === "pt" ? [".", ","] : [",", "."];
  const groupRe = new RegExp(`^\\d{1,3}(\\${group}\\d{3})+(\\${decimal}\\d+)?$`);
  if (groupRe.test(s)) return s.split(group).join("").replace(decimal, ".");
  if (new RegExp(`^\\d+(\\${decimal}\\d+)?$`).test(s)) return s.replace(decimal, ".");
  return null; // e.g. "1.234,5" in an English request: refuse rather than guess
}

const KINDS = [
  { kind: "withdraw", re: /\b(withdraw|take out|pull out|redeem|cash out|exit|sac(ar|ue)|retir(ar|e)|resgat(ar|e))\b/i },
  { kind: "deposit", re: /\b(deposit|supply|put|invest|lend|park|allocate|deposit(ar|e)|aplic(ar|ue)|invest(ir|a)|coloc(ar|ue)|empresta(r)?)\b/i },
  { kind: "positions", re: /\b(positions?|portfolio|holdings?|balances?|what do i (have|hold)|posi(ç|c)(ão|ao|ões|oes)|carteira|saldos?|quanto tenho)\b/i },
  { kind: "rates", re: /\b(rates?|apy|apr|yields?|best|highest|compare|taxas?|rendimentos?|melhor|maior|comparar|juros)\b/i },
];

export const languageOf = (text) => (PORTUGUESE.test(text) ? "pt" : "en");

/** USDC amount in base units (6 decimals), or null when absent; throws when present but unreadable. */
export function parseAmount(text, lang = languageOf(text)) {
  const t = String(text).replace(ADDRESS, " ");
  const m = AMOUNT.exec(t);
  if (!m) return null;
  if (/[-−]\s*$/.test(t.slice(0, m.index))) throw new Error("the amount must be positive");
  const num = normalizeNumber(m[1], lang);
  if (num == null) throw new Error(`amount “${m[1]}” is ambiguous — write it as ${lang === "pt" ? "5000 or 5.000" : "5000 or 5,000"}`);
  const unit = m[2]?.toLowerCase();
  const scale = unit === "k" || unit === "mil" ? 1_000n : unit?.startsWith("m") ? 1_000_000n : 1n;
  const [i, f = ""] = num.split(".");
  if (f.length > 6) throw new Error("USDC has 6 decimals");
  // integer maths only: "2.5k" → 25 × 10^5 base units × 1000 = 2,500 USDC exactly
  const amount = BigInt(i + f) * 10n ** BigInt(6 - f.length) * scale;
  if (amount === 0n) throw new Error("the amount must be positive");
  return amount;
}

export function parseIntent(text) {
  const q = String(text ?? "").trim();
  if (!q) return { error: "empty request" };
  const kind = KINDS.find((k) => k.re.test(q))?.kind;
  const addr = q.match(ADDRESS)?.[0];
  const user = addr ? getAddress(addr.toLowerCase()) : null;
  if (!kind) return user ? { kind: "positions", user } : { error: "not understood — ask for rates, positions of 0x…, deposit N USDC, or withdraw N USDC from 0x…" };
  if (kind === "rates") {
    const amount = parseAmount(q);
    return amount ? { kind: "deposit", amount, user } : { kind: "rates" }; // "best rate for 50k" is a deposit question
  }
  if (kind === "positions") return user ? { kind, user } : { error: "which wallet? add its 0x… address" };
  if (kind === "deposit") {
    const amount = parseAmount(q);
    return amount ? { kind, amount, user } : { error: "how much USDC? e.g. “deposit 5,000 USDC”" };
  }
  // withdraw
  if (!user) return { error: "a withdrawal needs the wallet that holds the position: add its 0x… address" };
  if (/\b(all|everything|tudo|todo)\b/i.test(q)) return { kind, amount: "all", user };
  const amount = parseAmount(q);
  return amount ? { kind, amount, user } : { error: "how much USDC to withdraw? (or “all”)" };
}
