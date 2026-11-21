// CairnX scanner numeric-feed pins: real Scanner against MOCK indexers.
// Pins the CRITIC-REVISED epoch policy: expires_epoch goes through the sentinel-tolerant reqEpoch
// (the indexer deliberately clamps attacker-chosen u64 epochs to a 2^53 sentinel
// that the resolver rejects PER-RECORD; a safe-integer throw in the scanner would be an on-chain
// 0.25-CSD whole-resolver-freeze DoS), while genuine garbage (non-numeric/negative/absent) still
// aborts the scan loud, and score / mined-tx height ride the strict reqOrd (honest feeds always
// carry safe integers there; a lying indexer aborts loud rather than resolve unordered state).
import assert from "node:assert/strict";
import http from "node:http";
import { deploy, mint, offer } from "@inversealtruism/cairnx-core";
import { resolve } from "@inversealtruism/cairnx-core";
import { Scanner } from "../../src/scanner.js";
import { ACTIVATION_HEIGHT, DOMAIN, EPOCH_LEN } from "@inversealtruism/cairnx-core";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const H = ACTIVATION_HEIGHT + 40; // pre-v11/v13 → no protocol fee / no taker-bind, isolates the epoch check
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const ee = Math.floor(H / EPOCH_LEN) + 24;
const SENTINEL = 2 ** 53; // the indexer's u64 clamp sentinel; NOT a safe integer

const off = offer({ give: { ticker: "DUST", amount: "100" }, want: { value: "50000000" } });
const dep = deploy({ ticker: "DUST", decimals: 0, supply: "1000", mint: "open", mintLimit: "1000" });
const mnt = mint({ ticker: "DUST" });

interface Fixture {
  proposals: unknown[];
  txs: Record<string, unknown>;
  attestations?: Record<string, unknown[]>;
}

/** One scan against a throwaway mock indexer serving the fixture. */
async function runScan(fx: Fixture) {
  const mock = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url!, "http://x").pathname);
    const send = (b: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (p === "/blocks/tip/height") return send(H + 10);
    if (p === `/domain/${DOMAIN}/proposals`) return send(fx.proposals);
    let m = /^\/proposal\/(0x[0-9a-f]{64})\/attestations$/.exec(p);
    if (m) return send(fx.attestations?.[m[1]!] ?? []);
    m = /^\/tx\/(0x[0-9a-f]{64})$/.exec(p);
    if (m && fx.txs[m[1]!]) return send(fx.txs[m[1]!]);
    res.writeHead(404); res.end("{}");
  });
  await new Promise<void>((ok) => mock.listen(0, "127.0.0.1", () => ok()));
  const port = (mock.address() as { port: number }).port;
  try {
    return await new Scanner({ indexerUrl: `http://127.0.0.1:${port}` }).scan();
  } finally {
    mock.close();
  }
}

const offerRow = (expires: unknown) => ({ txid: id(1), domain: DOMAIN, payload_hash: off.payloadHash, uri: off.uri, expires_epoch: expires, proposer: A, height: H });
const offerTx = (height: unknown = H) => ({ [id(1)]: { txid: id(1), height, pos: 1, outputs: [{ addr: A, value: 1 }] } });

// ── 1) the 2^53 SENTINEL flows THROUGH: scan does NOT throw, the record is present, and the
//       resolver rejects it PER-RECORD (a lone hostile anchor can never freeze the whole resolver).
//       Test BOTH wire forms: a JS number AND the decimal string the indexer actually emits for a
//       value > MAX_SAFE_INTEGER (queries.ts jsonSafe → v.toString()), the DoS-critical path is the
//       string one, so pin it explicitly.
for (const [form, wire] of [["number", SENTINEL], ["decimal string (the real indexer wire form)", String(SENTINEL)]] as const) {
  const { events, tipHeight } = await runScan({ proposals: [offerRow(wire)], txs: offerTx() });
  assert.equal(events.length, 1, "the sentinel-epoch proposal is scanned, not dropped/thrown");
  assert.equal((events[0] as { expiresEpoch: number }).expiresEpoch, SENTINEL, "sentinel passes through UNCHANGED");
  const st = resolve(events, tipHeight);
  assert.equal(Object.keys(st.offers).length, 0, "resolver refused the sentinel-epoch offer");
  const ev = st.events.find((e) => e.id === id(1));
  assert.ok(ev && !ev.ok && /safe-integer/.test(ev.note ?? ""), "per-record refusal with the safe-integer note");
  console.log(`  ok 2^53 sentinel expires_epoch (${form}) flows through, resolver rejects per-record, scan survives`);
}

// ── 2) genuine GARBAGE expires_epoch aborts the scan loud (wrong state is worse than no state)
for (const [label, bad] of [["non-numeric string", "abc"], ["null", null], ["negative", -1]] as const) {
  await assert.rejects(
    () => runScan({ proposals: [offerRow(bad)], txs: offerTx() }),
    /expires_epoch/,
    `garbage expires_epoch (${label}) must throw`);
  console.log(`  ok garbage expires_epoch (${label}) aborts the scan loud`);
}

// ── 3) a NaN attest score aborts the scan loud (reqOrd: score feeds fill/cancel/claim semantics)
{
  const proposals = [
    { txid: id(1), domain: DOMAIN, payload_hash: dep.payloadHash, uri: dep.uri, expires_epoch: ee, proposer: A, height: H },
    { txid: id(2), domain: DOMAIN, payload_hash: off.payloadHash, uri: off.uri, expires_epoch: ee, proposer: A, height: H + 1 },
  ];
  const txs = {
    [id(1)]: { txid: id(1), height: H, pos: 1, outputs: [{ addr: A, value: 1 }] },
    [id(2)]: { txid: id(2), height: H + 1, pos: 1, outputs: [{ addr: A, value: 1 }] },
    [id(3)]: { txid: id(3), height: H + 2, pos: 1, outputs: [{ addr: A, value: 50000000 }] },
  };
  const attestations = { [id(2)]: [{ txid: id(3), proposal_id: id(2), attester: B, score: "wat", height: H + 2 }] };
  await assert.rejects(() => runScan({ proposals, txs, attestations }), /attest score/, "NaN score must throw");
  console.log("  ok NaN attest score aborts the scan loud");
}

// ── 4) mined-tx height: garbage throws (the old `Number(t.height) || height` fallback masked it);
//       a plain decimal STRING is still accepted (reqOrd's honest-JSON tolerance)
{
  await assert.rejects(
    () => runScan({ proposals: [offerRow(ee)], txs: offerTx("0xff") }),
    /tx height/,
    "garbage /tx height must throw");
  console.log("  ok garbage mined-tx height aborts the scan loud (no silent row-height fallback)");

  const { events } = await runScan({ proposals: [offerRow(ee)], txs: offerTx(String(H)) });
  assert.equal(events.length, 1, "decimal-string /tx height is accepted");
  console.log("  ok decimal-string mined-tx height still accepted (honest feed unchanged)");
}

console.log("\nscan-epoch: all pins passed");
