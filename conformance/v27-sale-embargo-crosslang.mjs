// v27-sale-embargo-crosslang.mjs: regression for V27, the young-name SALE-embargo relaxation. Proves,
// against BOTH the JS resolver and the independent Python reference, byte-identical:
//   • a name registered under the V25 sealed model (commit -> payment-free reveal -> nfinalize) that is
//     between the NEW (REG_COMMIT_MAX_BLOCKS ~16min) and OLD (COMMIT_MAX_BLOCKS ~8h) embargo age is:
//       - REJECTED for sale at an EVENT height < V27 (old 240-block embargo: too young), and
//       - ACCEPTED for sale at an EVENT height >= V27 (new 8-block embargo: old enough);
//   • a name already older than the OLD embargo is sellable under BOTH rules (V27 changes nothing for it);
//   • below V27 the 240-block rule is unchanged (non-retroactive: the straddle's pre-V27 leg is the old rule).
// The redundancy the gate exploits: an offer requires a finalized (non-pending) name, and finalize needs the
// displacement freeze (REG_COMMIT_MAX_BLOCKS) to have passed, so by the time any sale can exist every
// window-valid displacer's reveal deadline is closed and the short embargo is sufficient.
import { spawnSync } from "node:child_process";
import * as R from "../packages/cairnx/dist/index.js";
const { resolve, canonicalState, payloadHash, canonicalJson, nameCommit, nameRegFee,
        V25_HEIGHT, V27_HEIGHT, REG_COMMIT_MAX_BLOCKS, COMMIT_MAX_BLOCKS, EPOCH_LEN } = R;
const TREAS = R.TREASURY_ADDR;
const A = "0x" + "a1".repeat(20);
const V25 = V25_HEIGHT, V27 = V27_HEIGHT, W = REG_COMMIT_MAX_BLOCKS;
if (V27 <= V25) throw new Error(`test misconfig: V27=${V27} must be > V25=${V25}`);
if (!(COMMIT_MAX_BLOCKS > W + 40)) throw new Error(`test misconfig: needs COMMIT_MAX_BLOCKS(${COMMIT_MAX_BLOCKS}) >> REG_COMMIT_MAX_BLOCKS(${W})`);
const nid = (() => { let i = 1; return () => "0x" + (i++).toString(16).padStart(64, "0"); })();
const cj = (r) => canonicalJson(r), ph = (r) => payloadHash(r);
const SALT = "a1a1a1a1a1a1a1a1";
const epochOf = (h) => Math.floor(h / EPOCH_LEN);

function commit(h, name, pos = 1) {
  const rec = { v: 1, t: "ncommit", commit: nameCommit(name, SALT, A) };
  return { kind: "propose", id: nid(), proposer: A, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: 9e14, paidTo: {} };
}
function reveal(h, name, pos = 1) {                                // PAYMENT-FREE sealed reveal at >= V25
  const rec = { v: 1, t: "name", name, salt: SALT };
  return { kind: "propose", id: nid(), proposer: A, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: 9e14, paidTo: {} };
}
function finalize(h, name, pos = 1) {                              // winner-only, carries the reg fee
  const rec = { v: 1, t: "nfinalize", name, salt: SALT };
  const fee = nameRegFee(name, h);
  return { kind: "propose", id: nid(), proposer: A, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: 9e14, paidTo: { [TREAS]: String(fee) } };
}
function offer(h, name, pos = 1) {                                 // list the name for sale (CSD-priced)
  const rec = { v: 1, t: "offer", give: { name }, want: { value: "100000000" } };
  return { kind: "propose", id: nid(), proposer: A, uri: cj(rec), payloadHash: ph(rec), height: h, pos, expiresEpoch: epochOf(h) + 24, paidTo: {} };
}

// register `name` under the sealed model with effHeight = commit height C; finalize at C + W + 2 (past the
// freeze). Returns { events, C, finalizeHeight }; the caller appends an offer at a chosen height.
function sealedReg(C, name) {
  const cH = C, rH = C + 2, fH = C + W + 2;
  return { events: [commit(cH, name), reveal(rH, name), finalize(fH, name)], C: cH, fH };
}

const jsState = (ev, tip) => resolve(ev, tip);
const jsCanon = (ev, tip) => canonicalState(resolve(ev, tip));
const pyCanon = (ev, tip) => { const r = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify({ resolve: [{ events: ev, tipHeight: tip }] }), encoding: "utf8" }); if (r.status) throw new Error(r.stderr); return JSON.parse(r.stdout).resolve[0]; };

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}`); };
const both = (n, ev, tip) => ok(`${n}: JS≡Python`, jsCanon(ev, tip) === pyCanon(ev, tip));
const nameLocked = (ev, tip, name) => !!jsState(ev, tip).names[name]?.locked;

console.log(`v27 sale-embargo relaxation (V25=${V25}, V27=${V27}, newEmbargo=${W}, oldEmbargo=${COMMIT_MAX_BLOCKS}):`);

// ── THE STRADDLE ── register a name whose age at the offer sits BETWEEN the new (W) and old (240) embargo.
// Commit at C so effHeight = C; offer at C + AGE with W < AGE <= COMMIT_MAX_BLOCKS.
{
  const C = V27 - 30;                     // commit 30 blocks before V27 (finalize at C+W+2 = V27-30+10 < V27)
  const { events, fH } = sealedReg(C, "sellme");
  const s0 = jsState(events, fH + 1);
  ok("setup: 'sellme' is finalized (non-pending) and owned by A", s0.names.sellme?.owner === A.toLowerCase() && !s0.names.sellme?.pending);

  // PRE-V27 leg: offer at height (< V27) with age in (W, 240] -> REJECTED by the old 240-block embargo.
  const hPre = V27 - 1;                    // < V27; age = (V27-1) - (V27-30) = 29, which is > W(8) and <= 240
  ok(`sanity: pre-V27 offer age ${hPre - C} is in (newEmbargo ${W}, oldEmbargo ${COMMIT_MAX_BLOCKS}]`, hPre - C > W && hPre - C <= COMMIT_MAX_BLOCKS);
  const evPre = [...events, offer(hPre, "sellme")];
  ok("PRE-V27: a name too young for the OLD 240-block embargo is NOT sellable (offer rejected, name unlocked)", nameLocked(evPre, hPre + 1, "sellme") === false);
  both("pre-V27 young-name offer rejected", evPre, hPre + 1);

  // POST-V27 leg: the SAME name, offered at height (>= V27), same sub-240 age -> ACCEPTED by the new W embargo.
  const hPost = V27 + 5;                   // >= V27; age = (V27+5) - (V27-30) = 35, still <= 240 but > W
  ok(`sanity: post-V27 offer age ${hPost - C} is still <= oldEmbargo ${COMMIT_MAX_BLOCKS} (so only the gate flips it)`, hPost - C > W && hPost - C <= COMMIT_MAX_BLOCKS);
  const evPost = [...events, offer(hPost, "sellme")];
  ok("POST-V27: the SAME young name IS sellable under the new 8-block embargo (offer accepted, name locked)", nameLocked(evPost, hPost + 1, "sellme") === true);
  both("post-V27 young-name offer accepted", evPost, hPost + 1);
}

// ── CONTROL: a name older than the OLD embargo is sellable under BOTH rules (V27 changes nothing for it). ──
{
  const C = V27 - (COMMIT_MAX_BLOCKS + 60);    // old enough that age > 240 even at a pre-V27 offer
  const { events } = sealedReg(C, "oldname");
  const hPre = V27 - 10;                       // < V27; age = COMMIT_MAX_BLOCKS + 50 > 240
  ok(`control sanity: age ${hPre - C} exceeds the old embargo ${COMMIT_MAX_BLOCKS}`, hPre - C > COMMIT_MAX_BLOCKS);
  const evPre = [...events, offer(hPre, "oldname")];
  ok("CONTROL: a name past the OLD embargo is sellable even pre-V27 (V27 only relaxes YOUNG names)", nameLocked(evPre, hPre + 1, "oldname") === true);
  both("control: old-enough name sellable pre-V27", evPre, hPre + 1);
}

console.log(`\nv27 sale-embargo crosslang: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
