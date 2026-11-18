// Generator for the vectors of CONVENTION §33 (packages/cairnx/test/vectors/events.json). Each case states the facts
// it exists for (`want`: the result, the members and the event order, or the field under test); the shipping JS rule
// (the built dist) must meet them before its full result is recorded as `expect`. events-crosslang.mjs replays the
// file against the Python reference. Rewrites the whole file, one case per line.
// Run: node conformance/gen-events-vectors.mjs (after building packages/cairnx).
import { writeFileSync } from "node:fs";
import * as rule from "../packages/cairnx/dist/index.js";
import { runBlockCase, runTxCase } from "./events-run.mjs";

const { canonicalJson } = rule;
const RULE = { domain: "cairnx:v1", activationHeight: 29_860 };
if (canonicalJson(rule.CAIRNX_EVENT_RULE ?? null) !== canonicalJson(RULE)) throw new Error("CAIRNX_EVENT_RULE is not cairnx:v1 from 29,860");
const A = RULE.activationHeight, H = 100_000, V29 = 88_000;
const UPLINK = { domain: "uplink:v1", activationHeight: 100 };

const AU = "0x" + "a1".repeat(20), PA = "0x" + "b2".repeat(20), PB = "0x" + "c3".repeat(20), MINER = "0x" + "d4".repeat(20);
const HASH = "0x" + "ef".repeat(32);
let n = 0xe7e00000;
const nid = () => "0x" + (n++).toString(16).padStart(64, "0");
const up = (h) => "0x" + h.slice(2).toUpperCase();
const bare = (h) => h.slice(2).toUpperCase();
const out = (value, scriptPubkey = PA) => ({ value: String(value), scriptPubkey });
const NONE = { type: "None" };
const prop = (over = {}) => ({ type: "Propose", domain: "cairnx:v1", payloadHash: HASH, uri: "{\"v\":1}", expiresEpoch: "5000", ...over });
const att = (proposalId, over = {}) => ({ type: "Attest", proposalId, score: 100, confidence: 0, ...over });
const tx = (pos, app, txid = nid(), outputs = [out(25_000_000)]) => ({ pos, txid, app, outputs });
const cb = () => tx(0, NONE, nid(), [out(5_000_000_000, MINER)]);
const at = (height, pos, app, outputs = [out(25_000_000)], txid = nid()) => ({ txid, height, pos, app, outputs });

const T = [];
const t = (name, input, author, want, r) => T.push({ name, ...(r ? { rule: r } : {}), input, author, want });

{
  const id = nid();
  t("tx-forms-propose", at(H, 3, prop({ payloadHash: bare(HASH) }), [out(5, bare(PA)), out(7, PA), out(0, up(PB))], up(id)), up(AU),
    { kind: "propose", id, proposer: AU, payloadHash: HASH, uri: "{\"v\":1}", expiresEpoch: 5000, height: H, pos: 3, paidTo: { [PA]: "12", [PB]: "0" } });
  const pid = nid();
  t("tx-forms-attest", at(H, 4, att(up(pid), { confidence: 1_000_000 })), AU,
    { kind: "attest", proposalId: pid, attester: AU, score: 100, confidence: 1_000_000, height: H, pos: 4, paidTo: { [PA]: "25000000" } });
}
t("tx-none", at(H, 2, NONE), AU, null);
t("tx-domain-other", at(H, 1, prop({ domain: "uplink:v1" })), AU, null);
t("tx-domain-case", at(H, 1, prop({ domain: "CAIRNX:V1" })), AU, null);
t("tx-domain-space", at(H, 1, prop({ domain: "cairnx:v1 " })), AU, null);
t("tx-floor-propose", at(A - 1, 1, prop()), AU, null);
t("tx-floor-attest", at(A - 1, 1, att(nid())), AU, null);
t("tx-floor-at", at(A, 1, prop()), AU, { kind: "propose", height: A });
t("tx-expiry-max-safe", at(H, 1, prop({ expiresEpoch: "9007199254740991" })), AU, { expiresEpoch: 9007199254740991 });
t("tx-expiry-2p53", at(H, 1, prop({ expiresEpoch: "9007199254740992" })), AU, { expiresEpoch: 9007199254740992 });
t("tx-expiry-u64max", at(H, 1, prop({ expiresEpoch: "18446744073709551615" })), AU, { expiresEpoch: 9007199254740992 });
t("tx-uri-nul", at(H, 1, prop({ uri: "a\u0000b\u0000" })), AU, { uri: "a\u0001b\u0001" });
t("tx-uri-u0001", at(H, 1, prop({ uri: "\u0001x" })), AU, { uri: "\u0001x" });
t("tx-outputs-big", at(H, 1, prop(), [out("9007199254740991"), out("9007199254740991"), out("9007199254740992", PB), out("18446744073709551615", PB)]), AU,
  { paidTo: { [PA]: "18014398509481982" } });
t("tx-attest-unknown", at(H, 1, att(nid())), AU, { kind: "attest" });
t("tx-coinbase-none", at(H, 0, NONE), AU, null);
t("tx-coinbase-payload", at(H, 0, prop()), AU, "error");
t("tx-author-missing", at(H, 1, prop()), null, "error");
t("tx-author-nonmember", at(H, 1, NONE), null, null);
t("tx-author-below-A", at(A - 1, 1, prop()), null, null);
t("tx-bad-txid", at(H, 1, prop(), undefined, "0x" + "ab".repeat(31)), AU, "error");
t("tx-bad-payloadhash", at(H, 1, prop({ payloadHash: "0x" + "zz".repeat(32) })), AU, "error");
t("tx-bad-script-pubkey", at(H, 1, prop(), [out(1, "0x" + "ab".repeat(21))]), AU, "error");
t("tx-bad-score", at(H, 1, att(nid(), { score: 4294967296 })), AU, "error");
t("tx-bad-confidence", at(H, 1, att(nid(), { confidence: -1 })), AU, "error");
t("tx-bad-height", at(-1, 1, prop()), AU, "error");
t("tx-bad-pos", at(H, 1.5, prop()), AU, "error");
t("tx-bad-expiry-negative", at(H, 1, prop({ expiresEpoch: "-1" })), AU, "error");
t("tx-bad-expiry-2p64", at(H, 1, prop({ expiresEpoch: "18446744073709551616" })), AU, "error");
t("tx-bad-value-2p64", at(H, 1, prop(), [out("18446744073709551616")]), AU, "error");
t("tx-bad-uri-surrogate", at(H, 1, prop({ uri: "\ud800" })), AU, "error");
t("tx-bad-author", at(H, 1, prop()), AU + "a", "error");
t("tx-bad-app-type", at(H, 1, { type: "Transfer" }), AU, "error");
t("tx-bad-domain-type", at(H, 1, prop({ domain: 7 })), AU, "error");
t("tx-rule-uplink-member", at(100, 1, prop({ domain: "uplink:v1" })), AU, { kind: "propose", height: 100 }, UPLINK);
t("tx-rule-uplink-other", at(100, 1, prop()), AU, null, UPLINK);
t("tx-rule-bad-empty", at(H, 1, prop()), AU, "error", { domain: "", activationHeight: 0 });
t("tx-rule-bad-u0001", at(H, 1, prop()), AU, "error", { domain: "x\u0001", activationHeight: 0 });
t("tx-rule-bad-height", at(H, 1, prop()), AU, "error", { domain: "cairnx:v1", activationHeight: -1 });

const B = [];
const authorsOf = (blocks, except = []) => Object.fromEntries(blocks.flatMap((b) => b.txs)
  .filter((x) => x.app.type !== "None" && !except.includes(x.txid)).map((x) => [x.txid, AU]));
const b = (name, blocks, want, { r, except } = {}) => B.push({ name, ...(r ? { rule: r } : {}), blocks, authors: authorsOf(blocks, except), want });
const blk = (height, txs) => ({ height, txs });
const copy = (x, pos) => ({ ...x, pos });

{ const p = tx(1, prop()), a = tx(2, att(p.txid)); b("blk-same-block", [blk(H, [cb(), p, a])], { members: [[1, 2]], ids: [p.txid, a.txid] }); }
{ const p = tx(2, prop()), a = tx(1, att(p.txid)); b("blk-attest-first", [blk(H, [cb(), a, p])], { members: [[1, 2]], ids: [p.txid, a.txid] }); }
{
  const p2 = tx(2, prop()), p3 = tx(3, prop()), a1 = tx(1, att(p3.txid)), a4 = tx(4, att(p2.txid));
  b("blk-order", [blk(H, [cb(), a1, p2, p3, a4])], { members: [[1, 2, 3, 4]], ids: [p2.txid, p3.txid, a1.txid, a4.txid] });
}
{ const p = tx(1, prop({ domain: "uplink:v1" })); b("blk-other-domain", [blk(H, [cb(), p, tx(2, att(p.txid))])], { members: [[]], ids: [] }); }
{
  const p = tx(1, prop()), a = tx(1, att(p.txid));
  b("blk-across", [blk(H, [cb(), p]), blk(H + 1, [cb(), a])], { members: [[1], [1]], ids: [p.txid, a.txid] });
}
b("blk-unknown", [blk(H, [cb(), tx(1, att(nid()))])], { members: [[]], ids: [] });
{ const p = tx(1, prop()); b("blk-below-A", [blk(A - 1, [cb(), p]), blk(A + 1, [cb(), tx(1, att(p.txid))])], { members: [[], []], ids: [] }); }
{ const x = tx(1, prop()); b("blk-below-A-unread", [blk(A - 1, [tx(0, prop()), x, copy(x, 1)])], { members: [[]], ids: [] }); }
{
  const x = tx(1, prop()), a = tx(2, att(x.txid));
  b("blk-repeat", [blk(H, [cb(), x, a]), blk(H + 5, [cb(), copy(x, 1)]), blk(H + 6, [cb(), copy(a, 1)])], { members: [[1, 2], [], []], ids: [x.txid, a.txid] });
}
{ const x = tx(1, prop()); b("blk-repeat-v29", [blk(V29 - 1, [cb(), x]), blk(V29 + 1, [cb(), x])], { members: [[1], []], ids: [x.txid], heights: [V29 - 1] }); }
{ const x = tx(1, prop()); b("blk-repeat-in-block", [blk(H, [cb(), x, copy(x, 2)])], { error: 0 }); }
{ const x = tx(1, prop()); b("blk-repeat-in-block-case", [blk(H, [cb(), x, { ...copy(x, 2), txid: up(x.txid) }])], { error: 0 }); }
{
  const x = tx(1, prop()), a = tx(2, att(x.txid));
  b("blk-remined-attested", [blk(H, [cb(), x]), blk(H + 3, [cb(), x, a])], { members: [[1], [2]], ids: [x.txid, a.txid] });
}
{ const x = tx(1, prop()); b("blk-first-at-or-above-A", [blk(A - 5, [cb(), x]), blk(A + 5, [cb(), x])], { members: [[], [1]], ids: [x.txid], heights: [A + 5] }); }
{
  const p = tx(1, prop()), a = tx(2, att(p.txid)), aa = tx(1, att(a.txid));
  b("blk-attest-on-attest", [blk(H, [cb(), p, a]), blk(H + 1, [cb(), aa])], { members: [[1, 2], []], ids: [p.txid, a.txid] });
}
{ const p = tx(1, prop()); b("blk-coinbase", [blk(H, [cb(), p])], { members: [[1]], ids: [p.txid] }); }
b("blk-coinbase-payload", [blk(H, [tx(0, prop()), tx(1, prop())])], { error: 0 });
{ const p2 = tx(2, prop()); b("blk-author-missing", [blk(H, [cb(), tx(1, prop()), p2])], { error: 0 }, { except: [p2.txid] }); }
{
  const p7 = tx(7, prop()), p12 = tx(12, prop()), a3 = tx(3, att(p7.txid));
  b("blk-sparse", [blk(H, [a3, p7, p12])], { members: [[3, 7, 12]], ids: [p7.txid, p12.txid, a3.txid] });
}
{ const p = tx(2, prop()); b("blk-pos-gap", [blk(H, [cb(), p])], { members: [[2]], ids: [p.txid] }); }
b("blk-pos-not-increasing", [blk(H, [cb(), tx(3, prop()), tx(2, prop())])], { error: 0 });
b("blk-pos-repeated", [blk(H, [cb(), tx(3, prop()), tx(3, prop())])], { error: 0 });
b("blk-pos-negative", [blk(H, [tx(-1, prop())])], { error: 0 });
{ const x = tx(1, prop()); b("blk-error-later", [blk(H, [cb(), tx(1, prop())]), blk(H + 1, [cb(), x, copy(x, 2)])], { error: 1 }); }
{
  const p1 = tx(1, prop({ domain: "uplink:v1" })), p2 = tx(2, prop()), a3 = tx(3, att(p1.txid)), a4 = tx(4, att(p2.txid));
  b("blk-rule-uplink", [blk(100, [cb(), p1, p2, a3, a4])], { members: [[1, 3]], ids: [p1.txid, a3.txid] }, { r: UPLINK });
}

// ── check the facts, record the JS result ──
const fails = [];
const same = (a, b2) => canonicalJson(a) === canonicalJson(b2);
for (const c of T) {
  c.expect = runTxCase(rule, c, RULE);
  if (c.want === null || c.want === "error") { if (!same(c.expect, c.want)) fails.push(`${c.name}: got ${canonicalJson(c.expect)}`); continue; }
  if (!c.expect || typeof c.expect !== "object") { fails.push(`${c.name}: got ${canonicalJson(c.expect)}`); continue; }
  for (const [k, v] of Object.entries(c.want)) if (!same(c.expect[k], v)) fails.push(`${c.name}: ${k} = ${canonicalJson(c.expect[k] ?? null)}`);
}
const idOf = (e) => (e.kind === "propose" ? e.id : e.txid);
for (const c of B) {
  c.expect = runBlockCase(rule, c, RULE);
  const w = c.want, g = c.expect;
  if ("error" in w) { if (!same(g, w)) fails.push(`${c.name}: got ${canonicalJson(g)}`); continue; }
  if (!g.events) { fails.push(`${c.name}: got ${canonicalJson(g)}`); continue; }
  if (!same(g.members, w.members)) fails.push(`${c.name}: members ${canonicalJson(g.members)}`);
  if (!same(g.events.map(idOf), w.ids)) fails.push(`${c.name}: order ${canonicalJson(g.events.map(idOf))}`);
  if (w.heights && !same(g.events.map((e) => e.height), w.heights)) fails.push(`${c.name}: heights ${canonicalJson(g.events.map((e) => e.height))}`);
}
if (fails.length) { for (const f of fails) console.error(`  FACT FAILED ${f}`); console.error(`\n${fails.length} fact(s) failed: events.json not written`); process.exit(1); }

const line = ({ want: _w, ...c }) => JSON.stringify(c);
const path = new URL("../packages/cairnx/test/vectors/events.json", import.meta.url);
writeFileSync(path, `{"format":1,"rule":${JSON.stringify(RULE)},"generatedFrom":"shipping JS rule, conformance/gen-events-vectors.mjs",\n`
  + `"tx":[\n${T.map(line).join(",\n")}\n],\n"blocks":[\n${B.map(line).join(",\n")}\n]}\n`);
console.log(`wrote ${T.length} tx and ${B.length} blocks vectors -> events.json (every hand-written fact held)`);
