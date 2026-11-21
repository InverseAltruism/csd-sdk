// M3-B1-03: when the chain-order feed cannot be trusted to continue the kept events, the scan pulls in full instead,
// so the worst a broken or missing feed costs is today's full pull, never a dropped or doubled event. Each case: a
// scan that falls back emits what a fresh scanner does, and the next clean scan reads on from the feeds again. Also
// pinned: a refused scan keeps nothing of its own, and past the bound every scan is the full pull.
import assert from "node:assert/strict";
import { Scanner, branchRefusal, type ScanOptions } from "../../src/scanner.js";
import { deploy, mint } from "@inversealtruism/cairnx-core";
import { A, B, C, H0, KA, KB, KC, KEYS, buildChain, type Spec } from "./scan-chain.js";

const specs: Spec[] = [
  { kind: "propose", rec: deploy({ ticker: "FBK", decimals: 0, supply: "1000", mint: "open", mintLimit: "10" }), proposer: A, height: H0 },
  { kind: "propose", rec: mint({ ticker: "FBK", amount: "1" }), proposer: B, height: H0 + 2 },
  { kind: "attest", of: 0, attester: B, score: 1, confidence: 0, height: H0 + 3 },
  { kind: "propose", rec: mint({ ticker: "FBK", amount: "2" }), proposer: C, height: H0 + 5 },
  { kind: "attest", of: 1, attester: C, score: 2, confidence: 0, height: H0 + 6 },
  { kind: "propose", rec: mint({ ticker: "FBK", amount: "3" }), proposer: A, height: H0 + 8 },
  { kind: "attest", of: 0, attester: C, score: 3, confidence: 0, height: H0 + 8 },
];
const chain = buildChain(specs);
type Body = { at: { height: number; hash: string }; rows: Record<string, unknown>[]; next: string | null };
/** Rewrites a feed answer: return a body, or a status for a non-200 answer. */
type Tamper = (path: string, body: Body) => Body | number;

function rig(opts: Partial<ScanOptions> = {}, c = chain) {
  const w = { tip: H0 + 4, tamper: null as Tamper | null, fullPulls: 0 };
  const f = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.startsWith("/domain/")) w.fullPulls++;
    const r = await c.indexer({ tip: w.tip })(url);
    if (!w.tamper || (u.pathname !== "/proposals" && u.pathname !== "/attestations") || !r.ok) return r;
    const out = w.tamper(u.pathname + u.search, (await r.json()) as Body);
    return typeof out === "number" ? ({ ok: false, status: out, json: async () => ({}) } as unknown as Response)
      : ({ ok: true, status: 200, json: async () => out } as unknown as Response);
  }) as unknown as typeof fetch;
  const s = new Scanner({ indexerUrl: "http://idx", fetch: f, ...opts });
  const fresh = () => new Scanner({ indexerUrl: "http://idx", ...opts, fetch: c.indexer({ tip: w.tip }) }).scan();
  /** One scan: whether it pulled in full, after checking it emits what a fresh scanner does. */
  const scan = async () => {
    w.fullPulls = 0;
    const r = await s.scan();
    assert.equal(branchRefusal(r.anchor), null);
    assert.deepEqual(r.events, (await fresh()).events, "the events a fresh scanner emits");
    return w.fullPulls > 0;
  };
  return { w, scan };
}

let passed = 0;
const ok = (name: string) => { passed++; console.log("  ok", name); };

const cases: [string, Tamper][] = [
  ["an indexer without the feeds (404)", () => 404],
  ["the snapshot block left the chain (409)", () => 409],
  ["the index is not ready (503)", () => 503],
  ["a body that is not a page", (_p, b) => ({ ...b, rows: { length: 0 } as unknown as Body["rows"] })],
  ["a page at another block", (_p, b) => ({ ...b, at: { ...b.at, hash: "0x" + "ee".repeat(32) } })],
  ["rows out of chain order", (_p, b) => ({ ...b, rows: [...b.rows].reverse() })],
  ["a row served twice", (_p, b) => ({ ...b, rows: b.rows.length ? [...b.rows, b.rows[b.rows.length - 1]!] : b.rows })],
  ["a row with a position that is not an integer", (_p, b) => ({ ...b, rows: b.rows.map((r) => ({ ...r, pos: "1e3" })) })],
  ["pages that say more follow, then an empty one", (_p, b) => ({ ...b, next: "1:1" })],
  ...(["proposals", "attestations"] as const).map((feed): [string, Tamper] => [`a new ${feed} row with the txid of a kept event`, (p, b) => {
    const kept = chain.txs.find((x) => x.height <= H0 + 4 && x.spec.kind === (feed === "proposals" ? "propose" : "attest"));
    return p.startsWith(`/${feed}`) && kept && b.rows[0] ? { ...b, rows: [{ ...b.rows[0], txid: kept.txid }, ...b.rows.slice(1)] } : b;
  }]),
  // the feed's first new row moved down to the height the kept events end at: a real transaction that /tx serves, so a
  // scan that took the row would emit it at that height instead of its own
  ...(["proposals", "attestations"] as const).map((feed): [string, Tamper] => [`a new ${feed} row at the height the scanner has read up to`, (p, b) =>
    (p.startsWith(`/${feed}`) && b.rows[0] ? { ...b, rows: [{ ...b.rows[0], height: H0 + 4, pos: 99 }, ...b.rows.slice(1)] } : b)]),
  ["an attestation of a proposal the scanner has not seen", (p, b) => (p.startsWith("/attestations") ? { ...b, rows: b.rows.map((r) => ({ ...r, proposal_id: "0x" + "ab".repeat(32) })) } : b)],
  // a record field no event can be built from, while the legacy endpoints serve the record intact
  ["an attestations row without its attester", (p, b) => (p.startsWith("/attestations") ? { ...b, rows: b.rows.map((r) => ({ ...r, attester: null })) } : b)],
  ["a proposals row whose expiry is not a number", (p, b) => (p.startsWith("/proposals") ? { ...b, rows: b.rows.map((r) => ({ ...r, expires_epoch: "soon" })) } : b)],
];
for (const [name, tamper] of cases) {
  const { w, scan } = rig();
  assert.equal(await scan(), true, `${name}: the first scan pulls in full`);
  w.tip = H0 + 8;
  w.tamper = tamper;
  assert.equal(await scan(), true, `${name}: the scan pulls in full`);
  w.tamper = null;
  assert.equal(await scan(), false, `${name}: paired, the next clean scan reads on from the feeds`);
  ok(`${name}: the scan pulls in full and emits a fresh scanner's events`);
}
{
  const { w, scan } = rig();
  assert.equal(await scan(), true);
  w.tip = H0 + 8;
  assert.equal(await scan(), false, "the same chain, clean: the scan reads on from the feeds");
  ok("paired: on a clean feed the scan after the first one reads on from it");
}

// A feed row's coordinates page the feed and set where the next read starts; its event takes its height and position
// from its transaction (/tx, or the merkle proof with verifyInclusion on). A row whose transaction the indexer places
// elsewhere makes the scan pull in full. In the first case the last row of a full page advertises a position past the
// rest of its block, so the next page starts after a row the scan has not read. In the second the feed reports block
// H0+6's proposals at H0+7, positions equal: a scan that compared positions only would keep them at the feed's height.
const pageEndCases: [string, Tamper][] = [
  ["a page whose last row advertises a position past the rest of its block", (p, b) =>
    (p.startsWith("/proposals") && b.rows.length === 2 ? { ...b, rows: [b.rows[0]!, { ...b.rows[1]!, pos: 7 }] } : b)],
  ["a feed row at another height than its transaction, position equal", (p, b) =>
    (p.startsWith("/proposals") ? { ...b, rows: b.rows.map((r) => (r.height === H0 + 6 ? { ...r, height: H0 + 7 } : r)) } : b)],
];
const pageEnd = buildChain([
  { kind: "propose", rec: deploy({ ticker: "PGE", decimals: 0, supply: "1000", mint: "open", mintLimit: "10" }), proposer: KA, height: H0 },
  ...[KA, KB, KC].map((who, i): Spec => ({ kind: "propose", rec: mint({ ticker: "PGE", amount: String(i + 1) }), proposer: who, height: H0 + 6 })),
  { kind: "attest", of: 0, attester: KB, score: 1, confidence: 0, height: H0 + 7 },
], { keys: KEYS });
const pageEndOn = pageEnd.verified({ verifiedTip: H0 + 8, confDepth: 0 });
for (const [name, tamper] of pageEndCases) {
  for (const [label, opts] of [["verifyInclusion off", {}], ["verifyInclusion on", pageEndOn]] as [string, Partial<ScanOptions>][]) {
    const { w, scan } = rig({ feedPageSize: 2, ...opts }, pageEnd);
    assert.equal(await scan(), true);
    w.tip = H0 + 8;
    w.tamper = tamper;
    assert.equal(await scan(), true, `${label}, ${name}: the scan pulls in full`);
    w.tamper = null;
    assert.equal(await scan(), false, `${label}, ${name}: paired, the next clean scan reads on from the feeds`);
    ok(`${label}: ${name}: the scan pulls in full`);
  }
}

// A well-formed feed row whose field the node's body contradicts (verifyInclusion on) is a verification failure, not a
// malformed row: the scan fails, as the full pull does on such a row (test/scan-bind-fields.test.ts).
{
  const { w, scan } = rig(pageEndOn, pageEnd);
  assert.equal(await scan(), true);
  w.tip = H0 + 8;
  w.tamper = (p, b) => (p.startsWith("/attestations") ? { ...b, rows: b.rows.map((r) => ({ ...r, attester: KC })) } : b);
  await assert.rejects(scan(), { message: /^F4: attestation attester for 0x[0-9a-f]{64} differs from the node's transaction body .* \(indexer misreporting\)$/ });
  ok("paired: a feed row whose well-formed field the node's body contradicts still fails the scan with verifyInclusion on");
}

// The feed right and /tx wrong: during the feed read the indexer serves /tx from a branch that re-mined the block with
// its two proposals' positions swapped. The scan pulls in full, and the /tx rows the feed read cached are taken back
// out first: a full pull that reused them would emit the other branch's positions.
{
  const top = H0 + 6;
  const two: Spec[] = [
    specs[0]!,
    { kind: "propose", rec: mint({ ticker: "FBK", amount: "1" }), proposer: B, height: top },
    { kind: "propose", rec: mint({ ticker: "FBK", amount: "2" }), proposer: C, height: top },
  ];
  const branches = {
    A: buildChain(two),
    B: buildChain(two.map((s, i) => (i === 1 ? { ...s, pos: 1 } : i === 2 ? { ...s, pos: 0 } : s)), { forks: [{ name: "B", from: top }] }),
  };
  const w = { tip: H0 + 4, txFromB: false, full: false };
  const f = (async (url: string) => {
    const p = new URL(url).pathname;
    if (p.startsWith("/domain/")) { w.full = true; w.txFromB = false; }
    return (w.txFromB && p.startsWith("/tx/") ? branches.B : branches.A).indexer({ tip: w.tip })(url);
  }) as unknown as typeof fetch;
  const s = new Scanner({ indexerUrl: "http://idx", fetch: f });
  await s.scan();
  Object.assign(w, { tip: H0 + 8, txFromB: true, full: false });
  const r = await s.scan();
  assert.equal(branchRefusal(r.anchor), null);
  const fresh = await new Scanner({ indexerUrl: "http://idx", fetch: branches.A.indexer({ tip: H0 + 8 }) }).scan();
  assert.deepEqual(r.events, fresh.events, `the scan emits the chain's positions (pulled in full: ${w.full})`);
  assert.equal(w.full, true, "the scan pulled in full");
  ok("a feed row /tx places elsewhere: the scan pulls in full and reads again what the feed read cached");
}

// A full pull that straddles a branch switch is refused; what it read must not become the kept events, which the
// next scan would read on from because they are anchored to the hash sampled before the switch. Branch B re-mines the
// last block with its two proposals' positions swapped (same txids). Two proposals, not a proposal and an
// attestation: the proposals feed after B's last kept position serves nothing on A, so no feed row exposes the stale
// positions and only this rule keeps them out of the next scan.
{
  const top = H0 + 8;
  const two: Spec[] = [...specs.slice(0, 6), { kind: "propose", rec: mint({ ticker: "FBK", amount: "9" }), proposer: C, height: top }];
  const swapped = two.map((s, i) => (i === 5 ? { ...s, pos: 1 } : i === 6 ? { ...s, pos: 0 } : s));
  const branches = { A: buildChain(two), B: buildChain(swapped, { forks: [{ name: "B", from: top }] }) };
  let br: "A" | "B" = "A", flipOnTx = false, fullPulls = 0;
  const f = (async (url: string) => {
    const p = new URL(url).pathname;
    if (p.startsWith("/domain/")) fullPulls++;
    if (flipOnTx && p.startsWith("/tx/")) { br = "B"; flipOnTx = false; }
    return branches[br].indexer({ tip: top })(url);
  }) as unknown as typeof fetch;
  const s = new Scanner({ indexerUrl: "http://idx", fetch: f });
  flipOnTx = true;
  const r1 = await s.scan();
  assert.equal(r1.anchor.branch, "moved", "setup: the first scan straddled the switch to B");
  br = "A";
  fullPulls = 0;
  const r2 = await s.scan();
  assert.equal(branchRefusal(r2.anchor), null);
  const fresh = await new Scanner({ indexerUrl: "http://idx", fetch: branches.A.indexer({ tip: top }) }).scan();
  assert.deepEqual(r2.events, fresh.events, `the next accepted scan carries A's positions (pulled in full: ${fullPulls > 0})`);
  assert.ok(fullPulls > 0, "nothing was kept from the refused scan, so the next one pulls in full");
  ok("a refused scan keeps no events: the next accepted scan carries the chain's positions");
}

// A full pull whose rows put an attestation at or below the declared tip and its proposal above it (a feed that lies
// about a row height) is emitted as read, and nothing is kept from it: the next scan pulls in full again.
{
  const P = chain.txs[1]!.txid;                    // the proposal at H0 + 2; one of its attestations is at H0 + 6
  const f = (async (url: string) => chain.indexer({ tip: H0 + 6, rowHeight: { [P]: H0 + 7 } })(url)) as unknown as typeof fetch;
  let full = 0;
  const counting = (async (url: string) => { if (new URL(url).pathname.startsWith("/domain/")) full++; return f(url); }) as unknown as typeof fetch;
  const s = new Scanner({ indexerUrl: "http://idx", fetch: counting });
  const fresh = await new Scanner({ indexerUrl: "http://idx", fetch: f }).scan();
  assert.deepEqual((await s.scan()).events, fresh.events);
  assert.deepEqual((await s.scan()).events, fresh.events);
  assert.equal(full, 2, "nothing was kept, so the second scan pulls in full too");
  ok("a full pull with an attestation whose proposal lies above the kept height keeps nothing: every scan pulls in full");
}

// The bound: past `keptMax` events nothing is kept and every scan is the full pull, which drops no event.
{
  const { scan } = rig({ keptMax: 2 });
  assert.equal(await scan(), true);
  assert.equal(await scan(), true, "over the bound at the first scan: the next one pulls in full too");
  ok("over the bound from the start: every scan pulls in full and emits a fresh scanner's events");
  const b = rig({ keptMax: 4 });
  assert.equal(await b.scan(), true);
  assert.equal(await b.scan(), false, "under the bound: the scan reads on from the feeds");
  b.w.tip = H0 + 8;
  assert.equal(await b.scan(), false, "the scan that crosses the bound still reads on, and emits every event");
  assert.equal(await b.scan(), true, "past the bound: the next scan pulls in full");
  ok("crossing the bound: that scan emits every event and the next ones pull in full");
}

console.log(`scan-incremental-fallback: ${passed} passed`);
