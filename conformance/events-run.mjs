// Runs one case of packages/cairnx/test/vectors/events.json (CONVENTION §33.7) through the JS rule: the generator
// records the result as `expect`, events-crosslang.mjs compares it with the Python reference's. `rule` is the
// cairnx-core module (built dist). A u64 written as a decimal string becomes a bigint, as a node read gives it.
const u64 = (v) => (typeof v === "string" && /^-?[0-9]+$/.test(v) ? BigInt(v) : v);
const decodeApp = (a) => (a && a.type === "Propose" ? { ...a, expiresEpoch: u64(a.expiresEpoch) } : a);
const decodeTx = (t) => ({
  pos: t.pos, txid: t.txid,
  tx: { app: decodeApp(t.app), outputs: t.outputs.map((o) => ({ ...o, value: u64(o.value) })) },
});
const idOf = (e) => (e.kind === "propose" ? e.id : e.txid);

/** The event, null, or "error". */
export function runTxCase(rule, c, fileRule) {
  try { return rule.eventOfTx(decodeTx(c.input), c.input.height, c.author, c.rule ?? fileRule); }
  catch { return "error"; }
}

/** {members, events} over the case's blocks with the two sets of §33.2 carried across them, or {error: i}. */
export function runBlockCase(rule, c, fileRule) {
  const eventIds = new Set(), proposeIds = new Set(), sofar = { eventIds, proposeIds };
  const members = [], events = [];
  for (let i = 0; i < c.blocks.length; i++) {
    const { height, txs } = c.blocks[i];
    const decoded = txs.map(decodeTx);
    let got;
    try {
      const ms = rule.blockMembers(height, decoded, sofar, c.rule ?? fileRule);
      const authors = ms.map((m) => c.authors[m.item.txid] ?? null);
      got = { positions: ms.map((m) => m.item.pos), evs: rule.blockEvents(height, decoded, sofar, authors, c.rule ?? fileRule) };
    } catch { return { error: i }; }
    members.push(got.positions);
    for (const e of got.evs) {
      eventIds.add(idOf(e));
      if (e.kind === "propose") proposeIds.add(e.id);
      events.push(e);
    }
  }
  return { members, events };
}
