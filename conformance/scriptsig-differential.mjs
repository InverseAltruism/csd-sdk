#!/usr/bin/env node
// Full-chain scriptSig attribution differential (Plan 57 B4; gates the B8c consumer swap).
//
// The scanner copies in cairn/src/lib/chainscan.ts and csd-indexer/src/decode.ts are being
// replaced by csd-crypto's signerAddrFromScriptSig. A parser swap in a scanning pipeline is a
// SEMANTICS change disguised as de-dup: any input whose attribution differs would silently
// change derived history. This tool proves zero deltas over EVERY input of EVERY tx on the live
// chain before any consumer swaps (and re-runs as the B8c gate).
//
//   node conformance/scriptsig-differential.mjs [--rpc http://127.0.0.1:8789] [--from 0] [--to <tip>]
//
// Exit 1 on any delta. Prints a COVERAGE line (standing directive: "0 violations" with thin
// coverage is weak evidence; say exactly what was swept).
import { signerAddrFromScriptSig } from "../packages/crypto/dist/index.js";
import { createHash } from "node:crypto";

// ── REFERENCE: verbatim port of the copies being replaced (cairn chainscan.ts == indexer
// decode.ts, byte-identical per the 2026-07-02 verification pass). Do NOT modernize this side:
// it must stay the OLD behavior so the diff is meaningful.
function refHash160(buf) {
  const sha = createHash("sha256").update(buf).digest();
  const rip = createHash("ripemd160").update(sha).digest();
  return "0x" + rip.toString("hex");
}
function refDeriveAddr(scriptSig) {
  if (!scriptSig) return null;
  const h = (scriptSig.startsWith("0x") ? scriptSig.slice(2) : scriptSig).toLowerCase();
  if (h.length < 2 + 128 + 2 + 66) return null;
  if (h.slice(0, 2) !== "40") return null;
  if (h.slice(130, 132) !== "21") return null;
  const pub = h.slice(132, 132 + 66);
  if (!/^[0-9a-f]{66}$/.test(pub)) return null;
  try { return refHash160(Buffer.from(pub, "hex")); } catch { return null; }
}

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const RPC = arg("--rpc", process.env.CSD_RPC || "http://127.0.0.1:8789");
const j = async (p) => { const r = await fetch(RPC + p, { signal: AbortSignal.timeout(15_000) }); if (!r.ok) throw new Error(`${p} -> ${r.status}`); return r.json(); };

const tip = (await j("/tip")).height;
const FROM = Number(arg("--from", 0));
const TO = Number(arg("--to", tip));
const CONC = 16;

let blocks = 0, txs = 0, inputs = 0, attributed = 0, nulls = 0, deltas = 0;
const sample = [];

async function checkBlock(h) {
  const b = await j(`/block/height/${h}`);
  if (!b.ok) throw new Error(`block ${h} not ok`);
  blocks++;
  for (const t of b.txs) {
    txs++;
    for (const i of t.inputs ?? []) {
      inputs++;
      const oldA = refDeriveAddr(i.script_sig);
      const newA = signerAddrFromScriptSig(i.script_sig);
      if (oldA !== newA) {
        deltas++;
        if (sample.length < 10) sample.push({ height: h, txid: t.txid, old: oldA, new: newA, scriptSig: String(i.script_sig).slice(0, 40) + "..." });
      } else if (oldA !== null) attributed++;
      else nulls++;
    }
  }
}

const started = Date.now();
for (let h = FROM; h <= TO; h += CONC) {
  const batch = [];
  for (let k = h; k < Math.min(h + CONC, TO + 1); k++) batch.push(checkBlock(k));
  await Promise.all(batch);
  if (blocks % 4096 < CONC) process.stdout.write(`  ...${blocks} blocks, ${inputs} inputs, ${deltas} deltas\r`);
}

console.log(`\nCOVERAGE: blocks ${FROM}..${TO} (${blocks}), txs ${txs}, inputs ${inputs} (attributed ${attributed}, null-both ${nulls}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (deltas > 0) {
  console.log(`DELTAS: ${deltas} attribution difference(s) old-vs-new. DO NOT swap the scanners.`);
  for (const s of sample) console.log(" ", JSON.stringify(s));
  process.exit(1);
}
console.log("ZERO DELTAS: signerAddrFromScriptSig is attribution-identical to the scanner copies over the full chain. Swap is safe at this tip.");
