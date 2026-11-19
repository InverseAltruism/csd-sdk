// The block bind accepts a served tx only as the node writes it. The node writes a tx's txid field as the id its body
// hashes to and every hash, address and script as 0x and lower-case hex; no hash commits the txid field, the codec
// reads a 32- or 20-byte field with or without 0x and in any case to the same bytes, and rpcTxToTx rebuilds any app
// type other than None and Propose as an Attest. Such a body hashes to the honest merkle root, and a consumer that
// reads the served text (verifyTxInclusion returns it; a Propose's payload_hash compared with a record's hash, an
// Attest's proposal_id with an offer id) is told another id or drops a record. Over the node capture of cairnx-replica (486 blocks,
// /block/height answers as the node served them; the two files' sha256 are pinned in its node-blocks.test.ts and
// hosted-blocks.test.ts): every block binds exactly as the bind's parts give it, and every non-canonical form the
// codec reads is refused.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LightClient, bindBlockBody, bindBlockTxs, type BlockBind } from "../src/index.js";
import { rpcHeaderToHeader, rpcTxToTx, type RpcTxJson } from "@inversealtruism/csd-client";
import { headerHash, txid as codecTxid } from "@inversealtruism/csd-codec";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { if (c) { pass++; console.log("  ✅ " + n); } else { fail++; console.log("  ❌ " + n); } };

interface Served { ok: boolean; hash: string; height: number; header: Parameters<typeof rpcHeaderToHeader>[0]; txs: RpcTxJson[] }
const here = dirname(fileURLToPath(import.meta.url));
const capture = ["node-blocks-29815-29859.json", "node-blocks-29860-30300.json"].flatMap((f) => {
  const c = JSON.parse(readFileSync(join(here, "../../replica/test/fixtures", f), "utf8")) as { answers: Record<string, string> };
  return Object.entries(c.answers).filter(([k]) => k.startsWith("/block/height/")).map(([, text]) => text);
});
const verifiedOf = (b: Served) => ({ height: b.height, hash: b.hash, header: rpcHeaderToHeader(b.header), chainwork: 0n });
const bigintText = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
const refusedFor = (r: BlockBind, field: string) => !r.ok && r.kind === "body-mismatch" && r.reason.includes(field);

// The non-canonical spellings of a 0x-prefixed lower-case hex string that the codec reads to the same bytes.
const FORMS: Record<string, (h: string) => string> = {
  "no 0x": (h) => h.slice(2),
  "no 0x, upper case": (h) => h.slice(2).toUpperCase(),
  "no 0x, mixed case": (h) => h.slice(2).replace(/[a-f]/, (c) => c.toUpperCase()),
  "0x, upper case": (h) => "0x" + h.slice(2).toUpperCase(),
  "0x, mixed case": (h) => "0x" + h.slice(2).replace(/[a-f]/, (c) => c.toUpperCase()),
};

console.log("the honest capture binds as the bind's parts give it:");
{
  let blocks = 0, txs = 0, same = 0;
  for (const text of capture) {
    const b = JSON.parse(text) as Served;
    blocks++;
    if (headerHash(rpcHeaderToHeader(b.header)) !== b.hash) continue;
    const r = bindBlockBody(text, verifiedOf(b));
    if (!r.ok || r.txs.length !== b.txs.length) continue;
    const exact = r.txs.every((t, i) => {
      const j = b.txs[i]!;
      return t.pos === i && t.txid === j.txid && t.txid === codecTxid(rpcTxToTx(j)) &&
        bigintText(t.tx) === bigintText(rpcTxToTx(j)) && bigintText(t.json) === bigintText(j);
    });
    if (exact) { same++; txs += r.txs.length; }
  }
  ok(`all ${blocks} recorded blocks bind, each tx at its position with the node's txid, rebuilt as rpcTxToTx rebuilds it and its json as served (${same} blocks, ${txs} txs)`,
    blocks === 486 && same === 486 && txs === 576);
}

console.log("every Propose payload_hash and Attest proposal_id of the capture, re-encoded:");
{
  let proposes = 0, attests = 0, apps = 0, tampered = 0, sameTxid = 0, textDiffers = 0, refused = 0, honestBinds = 0;
  for (const text of capture) {
    const b = JSON.parse(text) as Served, vh = verifiedOf(b);
    b.txs.forEach((t, i) => {
      if (t.app.type === "None") return;
      apps++;
      if (t.app.type === "Propose") proposes++; else attests++;
      const field = t.app.type === "Propose" ? "payload_hash" : "proposal_id";
      const honest = (t.app as unknown as Record<string, string>)[field]!;
      if (bindBlockBody(text, vh).ok) honestBinds++;
      for (const form of Object.values(FORMS)) {
        const bb = JSON.parse(text) as Served;
        (bb.txs[i]!.app as unknown as Record<string, string>)[field] = form(honest);
        tampered++;
        // The premise of the refusal: the codec gives the re-encoded tx the honest txid, so the merkle root matches,
        // while the text a consumer compares is no longer the honest one.
        if (codecTxid(rpcTxToTx(bb.txs[i]!)) === t.txid) sameTxid++;
        if ((bb.txs[i]!.app as unknown as Record<string, string>)[field] !== honest) textDiffers++;
        if (refusedFor(bindBlockBody(JSON.stringify(bb), vh), `tx ${i} serves app.${field}`)) refused++;
      }
    });
  }
  ok(`premise: each of the ${tampered} re-encoded txs keeps the honest txid and changes the compared text`, sameTxid === tampered && textDiffers === tampered);
  ok(`the ${apps} app txs (38 Propose, 5 Attest) bind honestly and each re-encoding (${tampered}) is refused as body-mismatch naming the field`,
    proposes === 38 && attests === 5 && apps === 43 && honestBinds === apps && tampered === apps * 5 && refused === tampered);
}

console.log("block 30,048: every hex field and the app type:");
const T30048 = capture.find((t) => (JSON.parse(t) as Served).height === 30_048)!;
const B30048 = JSON.parse(T30048) as Served, V30048 = verifiedOf(B30048);
const PI = B30048.txs.findIndex((t) => t.app.type === "Propose"), AI = B30048.txs.findIndex((t) => t.app.type === "Attest");
const edited = (edit: (b: Served) => void) => { const b = JSON.parse(T30048) as Served; edit(b); return bindBlockBody(JSON.stringify(b), V30048); };
{
  ok("premise: block 30,048 holds a coinbase, a Propose and an Attest, and binds", PI === 1 && AI === 2 && bindBlockBody(T30048, V30048).ok);
  const fields: [string, number, string, (b: Served) => { get: () => string; set: (v: string) => void }][] = [
    ["the Propose's", PI, "inputs[0].prev_txid", (b) => ({ get: () => b.txs[PI]!.inputs[0]!.prev_txid, set: (v) => { b.txs[PI]!.inputs[0]!.prev_txid = v; } })],
    ["the Propose's", PI, "inputs[0].script_sig", (b) => ({ get: () => b.txs[PI]!.inputs[0]!.script_sig, set: (v) => { b.txs[PI]!.inputs[0]!.script_sig = v; } })],
    ["the Propose's", PI, "outputs[0].script_pubkey", (b) => ({ get: () => b.txs[PI]!.outputs[0]!.script_pubkey, set: (v) => { b.txs[PI]!.outputs[0]!.script_pubkey = v; } })],
    ["the Attest's", AI, "outputs[0].script_pubkey", (b) => ({ get: () => b.txs[AI]!.outputs[0]!.script_pubkey, set: (v) => { b.txs[AI]!.outputs[0]!.script_pubkey = v; } })],
    ["the coinbase's", 0, "inputs[0].script_sig", (b) => ({ get: () => b.txs[0]!.inputs[0]!.script_sig, set: (v) => { b.txs[0]!.inputs[0]!.script_sig = v; } })],
  ];
  for (const [whose, pos, field, at] of fields) {
    let all = 0, refused = 0, premise = 0;
    for (const form of Object.values(FORMS)) {
      const b = JSON.parse(T30048) as Served, f = at(b), before = b.txs.map((t) => codecTxid(rpcTxToTx(t))).join();
      f.set(form(f.get()));
      all++;
      if (b.txs.map((t) => codecTxid(rpcTxToTx(t))).join() === before) premise++;
      if (refusedFor(bindBlockBody(JSON.stringify(b), V30048), `tx ${pos} serves ${field}`)) refused++;
    }
    ok(`${whose} ${field} in each of the ${all} other forms: same txids, refused as body-mismatch`, premise === all && refused === all);
  }
  // A non-coinbase scriptSig is not committed: any value keeps the txid, and only the form rule refuses it.
  ok("a non-coinbase script_sig that is not text (a number) is refused", refusedFor(edited((b) => { (b.txs[PI]!.inputs[0] as { script_sig: unknown }).script_sig = 7; }), `tx ${PI} serves inputs[0].script_sig`));
  ok("a non-coinbase script_sig written 0X… is refused", refusedFor(edited((b) => { b.txs[PI]!.inputs[0]!.script_sig = "0X" + b.txs[PI]!.inputs[0]!.script_sig.slice(2); }), `tx ${PI} serves inputs[0].script_sig`));
  for (const type of ["attest", "ATTEST", "Attest ", "x"]) {
    const b = JSON.parse(T30048) as Served;
    (b.txs[AI]!.app as { type: string }).type = type;
    ok(`an Attest typed ${JSON.stringify(type)} keeps its txid and is refused as body-mismatch`,
      codecTxid(rpcTxToTx(b.txs[AI]!)) === B30048.txs[AI]!.txid && refusedFor(bindBlockBody(JSON.stringify(b), V30048), `tx ${AI} serves app.type`));
  }
}

console.log("forms the codec already tells apart, and spellings JSON.parse erases:");
{
  const malformed = (r: BlockBind) => !r.ok && r.kind === "malformed";
  const mismatch = (r: BlockBind) => !r.ok && r.kind === "body-mismatch";
  ok("a 32-byte field written 0X… does not decode (malformed)", malformed(edited((b) => { (b.txs[PI]!.app as { payload_hash: string }).payload_hash = "0X" + (B30048.txs[PI]!.app as { payload_hash: string }).payload_hash.slice(2); })));
  ok("an app type None or Propose in another spelling does not decode (malformed)",
    malformed(edited((b) => { (b.txs[0]!.app as { type: string }).type = "none"; })) && malformed(edited((b) => { (b.txs[PI]!.app as { type: string }).type = "propose"; })));
  const asText = (get: (b: Served) => Record<string, unknown>, k: string) => malformed(edited((b) => { const o = get(b); o[k] = String(o[k]); }));
  ok("a number served as a string (version, vout, value, expires_epoch, score) does not decode (malformed)",
    asText((b) => b.txs[PI]! as unknown as Record<string, unknown>, "version") && asText((b) => b.txs[PI]!.inputs[0]! as unknown as Record<string, unknown>, "vout") &&
    asText((b) => b.txs[PI]!.outputs[0]! as unknown as Record<string, unknown>, "value") && asText((b) => b.txs[PI]!.app as unknown as Record<string, unknown>, "expires_epoch") &&
    asText((b) => b.txs[AI]!.app as unknown as Record<string, unknown>, "score"));
  ok("a domain or uri in other text encodes to other bytes (body-mismatch)",
    mismatch(edited((b) => { const a = b.txs[PI]!.app as { domain: string }; a.domain = a.domain.toUpperCase(); })) &&
    mismatch(edited((b) => { const a = b.txs[PI]!.app as { uri: string }; a.uri = a.uri.normalize("NFD") === a.uri ? a.uri + " " : a.uri.normalize("NFD"); })));
  const spelled = T30048.replace('"score":100', '"score":100.0').replace('"confidence":100', '"confidence":1e2').replace('"locktime":0,', '"locktime":-0,');
  const r = bindBlockBody(spelled, V30048), honest = bindBlockBody(T30048, V30048);
  ok("100.0, 1e2 and -0 parse to the numbers 100, 100 and -0: the body binds and every bound tx reads as the honest one",
    spelled !== T30048 && r.ok && honest.ok && JSON.stringify(r.txs, (_k, x) => (typeof x === "bigint" ? String(x) : x)) === JSON.stringify(honest.txs, (_k, x) => (typeof x === "bigint" ? String(x) : x)));
}

console.log("the served txid field, which no hash commits:");
{
  const ID = B30048.txs[PI]!.txid;
  const zero = edited((b) => { b.txs[PI]!.txid = "0x" + "00".repeat(32); });
  ok("tx 1 served with the txid 0x00..00 and its body untouched is refused as body-mismatch naming the field", refusedFor(zero, `tx ${PI} serves txid`));
  let respelled = 0;
  for (const form of Object.values(FORMS)) if (refusedFor(edited((b) => { b.txs[PI]!.txid = form(ID); }), `tx ${PI} serves txid`)) respelled++;
  ok(`the right id in each of the ${Object.keys(FORMS).length} other spellings (no 0x, upper or mixed case) is refused`, respelled === Object.keys(FORMS).length);
  // Every tx in the node's /block and /tx answers carries its txid (all 576 of the capture, and the front door relays
  // those bytes), so a tx without one is no node's answer.
  ok("a tx served without a txid field is refused", refusedFor(edited((b) => { delete (b.txs[PI] as { txid?: string }).txid; }), `tx ${PI} serves txid`));
  ok("the coinbase served with the Propose's txid is refused (before the repeated-txid check)", refusedFor(edited((b) => { b.txs[0]!.txid = ID; }), "tx 0 serves txid"));
  // A key written twice is read once, by the parse whose objects the bind returns: the last value is the one hashed and
  // the one a consumer reads. Only a consumer that parsed the text again with another parser could see the other.
  const dup = (first: string, last: string) => {
    const at = `"txid":"${ID}"`;
    if (T30048.split(at).length !== 2) throw new Error("the txid key is not once in the block text");
    return bindBlockBody(T30048.replace(at, `"txid":"${first}","txid":"${last}"`), V30048);
  };
  const lastHonest = dup("0x" + "00".repeat(32), ID), lastForged = dup(ID, "0x" + "00".repeat(32));
  ok("a txid key written twice: the last value decides, so a forged first value binds with the honest id in the returned json and a forged last one is refused",
    lastHonest.ok && lastHonest.txs[PI]!.json.txid === ID && refusedFor(lastForged, `tx ${PI} serves txid`));
  // Keys outside RpcTxJson are as served and committed by nothing; the bind and verifyTxInclusion read none of them.
  const extra = edited((b) => { Object.assign(b.txs[AI]!.app, { payload_hash: "0x" + "ee".repeat(32) }); Object.assign(b.txs[AI]!, { height: 1 }); });
  ok("a stray payload_hash on the Attest and a stray key on the tx bind: the Attest's committed fields are unchanged", extra.ok && extra.txs[AI]!.tx.app.type === "Attest" &&
    (extra.txs[AI]!.tx.app as { proposalId: string }).proposalId === (B30048.txs[AI]!.app as { proposal_id: string }).proposal_id);
}

console.log("verifyTxInclusion runs through the same rule:");
{
  const lcOf = (txs: RpcTxJson[]) => {
    const lc = new LightClient({ client: { tx: async () => ({ ok: true, txid: B30048.txs[PI]!.txid, height: 30_048 }), blockByHeight: async () => ({ ...B30048, txs }) } as never });
    lc.baseHeight = 30_048;
    (lc.chain as unknown as unknown[]).push(V30048);
    return lc;
  };
  const honest = await lcOf(B30048.txs).verifyTxInclusion(B30048.txs[PI]!.txid);
  const ph = (B30048.txs[PI]!.app as { payload_hash: string }).payload_hash;
  ok("honest: the Propose is proven with its payload_hash in the node's form", honest.included && honest.trustLevel === "verified-inclusion" && honest.appPayloadHash === ph);
  const bare = JSON.parse(T30048) as Served;
  (bare.txs[PI]!.app as { payload_hash: string }).payload_hash = ph.slice(2);
  const lied = await lcOf(bare.txs).verifyTxInclusion(B30048.txs[PI]!.txid);
  ok("a body serving that payload_hash without 0x proves nothing and surfaces no payload hash",
    !lied.included && lied.trustLevel === "rpc-trusted" && lied.appPayloadHash === undefined && lied.reason?.includes(`tx ${PI} serves app.payload_hash`) === true);
  ok("bindBlockTxs over the parsed body refuses it as bindBlockBody does", refusedFor(bindBlockTxs(bare.txs, V30048), `tx ${PI} serves app.payload_hash`));
  const zeroed = JSON.parse(T30048) as Served;
  zeroed.txs[PI]!.txid = "0x" + "00".repeat(32);
  const forged = await lcOf(zeroed.txs).verifyTxInclusion(B30048.txs[PI]!.txid);
  ok("a body serving the Propose with the txid 0x00..00 proves nothing and returns no tx", !forged.included && forged.trustLevel === "rpc-trusted" && forged.tx === undefined);
  ok("honest: the returned tx carries the requested txid", honest.tx?.txid === B30048.txs[PI]!.txid);
  const stray = JSON.parse(T30048) as Served;
  Object.assign(stray.txs[AI]!.app, { payload_hash: "0x" + "ee".repeat(32) });
  const lcAttest = new LightClient({ client: { tx: async () => ({ ok: true, txid: B30048.txs[AI]!.txid, height: 30_048 }), blockByHeight: async () => ({ ...B30048, txs: stray.txs }) } as never });
  lcAttest.baseHeight = 30_048;
  (lcAttest.chain as unknown as unknown[]).push(V30048);
  const att = await lcAttest.verifyTxInclusion(B30048.txs[AI]!.txid);
  ok("an Attest carrying a stray payload_hash is proven as the Attest it is, with no payload hash surfaced", att.included && att.appPayloadHash === undefined);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
