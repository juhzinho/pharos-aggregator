import { deposit, positions, rates, withdraw } from "./agent.js";
import { parseIntent } from "./intent.js";

/** The one interface: a plain request in, a routed, explained and prepared answer out. */
export async function ask(question, { faults = {} } = {}) {
  const t0 = Date.now();
  let intent;
  try {
    intent = parseIntent(question);
  } catch (e) {
    intent = { error: e.message };
  }
  if (intent.error) return { kind: "refused", question, outcome: "refused", summary: intent.error, explanation: [intent.error], ms: Date.now() - t0 };
  const run = { rates: () => rates({ faults }), positions: () => positions(intent.user, { faults }), deposit: () => deposit(intent.amount, intent.user, { faults }), withdraw: () => withdraw(intent.amount, intent.user, { faults }) }[intent.kind];
  const report = await run();
  return { question, intent: { ...intent, amount: intent.amount?.toString() }, faults, ...report, ms: Date.now() - t0 };
}

export const toJson = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
