// v24-fee-crosslang.mjs — regression for V24, the length-graded .csd registration/renewal fee gate. Proves,
// against BOTH the JS resolver and the Python reference, byte-identical:
//   • a registration at height >= V24 paying EXACTLY the OLD (V18) fee for a short name is REJECTED on both
//     sides (the V24 tier is higher), so the name is NOT registered — this is the exact stale-verifier fork
//     class the V24 hard-adoption-gate guards (a stale resolver that still priced at V18 would ACCEPT it);
//   • the SAME registration paying the V24 fee is ACCEPTED on both sides;
//   • below the gate (height < V24) the V18 price is the rule on both sides (non-retroactive / history-pinned);
//   • every length tier (<=3 / ==4 / 5-9 / >=10) prices identically, JS ≡ Python, across the boundary.
// Locks the JS/Python parity the audit flagged as missing for V24 (V20-V23 each had one).
import { spawnSync } from "node:child_process";
import * as R from "../packages/cairnx/dist/index.js";
const { resolve, canonicalState, payloadHash, canonicalJson, nameRegFee, V18_HEIGHT, V24_HEIGHT } = R;
const D = "0x" + "d0".repeat(20), TREAS = R.TREASURY_ADDR;
const nid = (() => { let i = 1; return () => "0x" + (i++).toString(16).padStart(64, "0"); })();

// A salt-less name registration at height h whose tx pays `feeUnits` (base units) to the treasury.
function regAt(h, name, feeUnits) {
  const rec = { v: 1, t: "name", name };
  return { kind: "propose", id: nid(), proposer: D, uri: canonicalJson(rec), payloadHash: payloadHash(rec), height: h, pos: 1, expiresEpoch: 9e15, paidTo: { [TREAS]: String(feeUnits) } };
}
const jsCanon = (ev, tip) => canonicalState(resolve(ev, tip));
const jsOwns = (ev, tip, name) => !!resolve(ev, tip).names?.[name];
const pyCanon = (ev, tip) => { const r = spawnSync("python3", [new URL("./cairnx_ref.py", import.meta.url).pathname], { input: JSON.stringify({ resolve: [{ events: ev, tipHeight: tip }] }), encoding: "utf8" }); if (r.status) throw new Error(r.stderr); return JSON.parse(r.stdout).resolve[0]; };
const pyOwns = (ev, tip, name) => !!JSON.parse(pyCanon(ev, tip)).names?.[name];   // pyCanon is the canonicalState STRING; parse to read names

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}`); };
const both = (n, ev, tip) => ok(`${n}: JS≡Python`, jsCanon(ev, tip) === pyCanon(ev, tip));

console.log(`v24 name-fee gate (V18=${V18_HEIGHT}, V24=${V24_HEIGHT}):`);

const N = "audit";                                       // 5 chars: V18=3 CSD, V24(MID 5-9)=5 CSD
const V18FEE = Number(nameRegFee(N, V18_HEIGHT));        // 300000000 (3 CSD)
const V24FEE = Number(nameRegFee(N, V24_HEIGHT));        // 500000000 (5 CSD)
ok("the gate actually raises this name's fee (V24 > V18)", V24FEE > V18FEE && V18FEE === 3e8 && V24FEE === 5e8);

// 1) at the gate, the OLD fee underpays → rejected (the stale-verifier fork the gate exists to prevent)
const under = [regAt(V24_HEIGHT, N, V18FEE)];
ok("≥V24 + old (V18) fee → NOT registered (JS)", jsOwns(under, V24_HEIGHT + 50, N) === false);
ok("≥V24 + old (V18) fee → NOT registered (Python)", pyOwns(under, V24_HEIGHT + 50, N) === false);
both("≥V24 underpaid registration", under, V24_HEIGHT + 50);

// 2) at the gate, paying the V24 fee → registered on both sides
const paid = [regAt(V24_HEIGHT, N, V24FEE)];
ok("≥V24 + V24 fee → registered (JS)", jsOwns(paid, V24_HEIGHT + 50, N) === true);
ok("≥V24 + V24 fee → registered (Python)", pyOwns(paid, V24_HEIGHT + 50, N) === true);
both("≥V24 correctly-paid registration", paid, V24_HEIGHT + 50);

// 3) below the gate, the V18 fee is still the rule (non-retroactive) — same 3 CSD registers on both sides
const pre = [regAt(V24_HEIGHT - 10, N, V18FEE)];
ok("<V24 + V18 fee → registered (JS)", jsOwns(pre, V24_HEIGHT - 10 + 50, N) === true);
both("<V24 pre-gate registration", pre, V24_HEIGHT - 10 + 50);

// 4) every length tier prices identically across the boundary (JS nameRegFee == the fee the Python resolver enforces)
for (const [name, label] of [["ab", "<=3 (2ch)"], ["abcd", "==4"], ["abcdef", "5-9 (6ch)"], ["abcdefghij", ">=10"]]) {
  const need = Number(nameRegFee(name, V24_HEIGHT));
  ok(`tier ${label}: V24 fee ${need / 1e8} CSD registers (JS)`, jsOwns([regAt(V24_HEIGHT, name, need)], V24_HEIGHT + 50, name) === true);
  ok(`tier ${label}: one unit under the V24 fee is REJECTED (JS)`, jsOwns([regAt(V24_HEIGHT, name, need - 1)], V24_HEIGHT + 50, name) === false);
  both(`tier ${label} at V24`, [regAt(V24_HEIGHT, name, need)], V24_HEIGHT + 50);
}

console.log(`\nv24 name-fee crosslang: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
