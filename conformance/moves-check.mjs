// The checks the token moves of a resolve() result (CONVENTION §41) must pass against the state the same call returned.
// It reads the result only and is written from the convention, not from src/resolve/; packages/cairnx/test/moves.test.ts
// and scripts/seal-differential.mjs both run it, so the two cannot drift apart.
//   - the identity: for every ticker and address, the amounts received less the amounts sent equal available plus
//     locked in `balances` (an address or ticker left out of `balances` holds 0);
//   - the mint moves of a ticker sum to its `minted`;
//   - an applied mint carries one mint move, an applied transfer one xfer move, and an applied fill the moves its offer's
//     fill record (§5) gives, in this order: on a token-priced offer a sale of `paid` from the buyer to `want.payto` and a
//     fee of `fee` from the buyer to the treasury; on a token give a fill from the seller to the buyer of `give.amount`
//     (a whole fill) or of the `fills[]` entry's `got` (a partial one); a zero amount gives no move;
//   - no other entry, refused or applied, carries `moves`, and none carries an empty one; every move has the five keys
//     in order, a known leg, a positive decimal amount, a ticker in `tokens`, and a null `from` exactly on a mint.

const LEGS = ["xfer", "mint", "fill", "sale", "fee"];
const POSITIVE = /^[1-9][0-9]*$/;
const KEYS = "leg,ticker,from,to,amount";

/**
 * @param {import("../packages/cairnx/src/index.js").CairnXState} state
 * @param {string} treasury
 */
export function checkMoves(state, treasury) {
  const problems = [];
  const legs = Object.fromEntries(LEGS.map((l) => [l, 0]));
  const net = new Map();                       // ticker NUL address -> received less sent
  const minted = new Map();                    // ticker -> sum of its mint moves
  const credit = (ticker, addr, v) => { const k = `${ticker}\u0000${addr}`; net.set(k, (net.get(k) ?? 0n) + v); };
  // Each fill record by the txid of its fill, in apply order: one txid repeated below V29 can fill a partial offer twice.
  const fillsByTxid = new Map();
  for (const o of Object.values(state.offers)) {
    const partial = Array.isArray(o.fills);
    for (const f of partial ? o.fills : o.fill ? [o.fill] : []) {
      const q = fillsByTxid.get(f.txid) ?? [];
      q.push({ o, f, partial });
      fillsByTxid.set(f.txid, q);
    }
  }
  const fillMoves = ({ o, f, partial }) => {
    const out = [];
    if (typeof o.want.ticker === "string") {
      out.push({ leg: "sale", ticker: o.want.ticker, from: f.buyer, to: o.want.payto, amount: f.paid });
      out.push({ leg: "fee", ticker: o.want.ticker, from: f.buyer, to: treasury, amount: f.fee });
    }
    if (typeof o.give.ticker === "string") out.push({ leg: "fill", ticker: o.give.ticker, from: o.seller, to: f.buyer, amount: partial ? f.got : o.give.amount });
    return out.filter((m) => m.amount !== "0");
  };
  const badMove = (m) => {
    if (!m || typeof m !== "object") return "not an object";
    if (Object.keys(m).join() !== KEYS) return `keys ${Object.keys(m).join()}`;
    if (!LEGS.includes(m.leg)) return `leg ${m.leg}`;
    if (typeof m.amount !== "string" || !POSITIVE.test(m.amount)) return `amount ${m.amount}`;
    if (typeof m.ticker !== "string" || !Object.hasOwn(state.tokens, m.ticker)) return `ticker ${m.ticker}`;
    if (typeof m.to !== "string") return "to";
    if ((m.from === null) !== (m.leg === "mint") || (m.from !== null && typeof m.from !== "string")) return `from ${m.from} on a ${m.leg}`;
    return null;
  };
  const fillsSeen = new Map();
  let entries = 0;
  for (const e of state.events) {
    const where = `${e.kind} ${e.id} at ${e.height}`;
    const has = Object.hasOwn(e, "moves");
    if (has && (!Array.isArray(e.moves) || e.moves.length === 0)) { problems.push(`${where}: moves is not a non-empty array`); continue; }
    const moves = has ? e.moves : [];
    if (!e.ok || !["mint", "transfer", "fill"].includes(e.kind)) {
      if (has) problems.push(`${where}: carries moves, but only an applied mint, transfer or fill moves tokens`);
      continue;
    }
    if (e.kind === "fill") {
      const i = fillsSeen.get(e.id) ?? 0;
      fillsSeen.set(e.id, i + 1);
      const rec = fillsByTxid.get(e.id)?.[i];
      if (!rec) { problems.push(`${where}: an applied fill with no fill record in the state`); continue; }
      const want = JSON.stringify(fillMoves(rec)), got = JSON.stringify(moves);
      if (want !== got) problems.push(`${where}: moves ${got}, the fill record gives ${want}`);
    } else {
      const leg = e.kind === "mint" ? "mint" : "xfer";
      if (moves.length !== 1 || moves[0].leg !== leg) problems.push(`${where}: moves ${JSON.stringify(moves)}, not one ${leg} move`);
    }
    if (has) entries++;
    for (const m of moves) {
      const bad = badMove(m);
      if (bad) { problems.push(`${where}: a move with a bad ${bad}`); continue; }
      legs[m.leg]++;
      const v = BigInt(m.amount);
      credit(m.ticker, m.to, v);
      if (m.from === null) minted.set(m.ticker, (minted.get(m.ticker) ?? 0n) + v);
      else credit(m.ticker, m.from, -v);
    }
  }
  const pairs = new Set(net.keys());
  for (const [t, byAddr] of Object.entries(state.balances)) for (const a of Object.keys(byAddr)) pairs.add(`${t}\u0000${a}`);
  for (const k of pairs) {
    const [t, a] = k.split("\u0000");
    const b = Object.hasOwn(state.balances, t) && Object.hasOwn(state.balances[t], a) ? state.balances[t][a] : null;
    const held = b ? BigInt(b.available) + BigInt(b.locked) : 0n;
    const moved = net.get(k) ?? 0n;
    if (moved !== held) problems.push(`identity: ${t} ${a} received less sent ${moved}, available plus locked ${held}`);
  }
  for (const [t, tok] of Object.entries(state.tokens)) {
    const sum = minted.get(t) ?? 0n;
    if (sum !== BigInt(tok.minted)) problems.push(`mint moves of ${t} sum to ${sum}, minted is ${tok.minted}`);
  }
  return { problems, legs, pairs: pairs.size, entries };
}
