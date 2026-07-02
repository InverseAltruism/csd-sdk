// paidToFromOutputs conformance (Plan 57 B4). This helper mirrors the cairnx service's proven
// Scanner.paidTo byte-for-byte (AUDIT L6 / DET-PAIDTO-1); these fixtures pin the exact contract
// so the mirror cannot drift silently: canonical decimal strings, BigInt-exact summation, and
// the skip-not-throw guard on every non-conforming value.
import { paidToFromOutputs } from "../src/paidto.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };
const deepEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const A = "0x" + "aa".repeat(20), B = "0x" + "bb".repeat(20);

ok("aggregates multiple outputs to the same addr (decimal strings)",
  deepEq(paidToFromOutputs([{ addr: A, value: 100 }, { addr: A, value: 25 }, { addr: B, value: 7 }]), { [A]: "125", [B]: "7" }));
// Discriminating fixture (review find): MAX_SAFE_INTEGER + 2 sums to 2^53+1, which a plain
// Number implementation rounds to 2^53 ("...992"); only true BigInt emits "...993".
ok("BigInt-exact past 2^53 (a Number implementation would emit ...992)",
  paidToFromOutputs([{ addr: A, value: Number.MAX_SAFE_INTEGER }, { addr: A, value: 2 }])[A] === "9007199254740993");
ok("empty outputs -> empty map", deepEq(paidToFromOutputs([]), {}));
ok("DET-PAIDTO-1 guard: negative, non-integer, unsafe, and non-number values are SKIPPED (not thrown)",
  deepEq(paidToFromOutputs([
    { addr: A, value: -1 },
    { addr: A, value: 1.5 },
    { addr: A, value: 2 ** 53 },
    { addr: A, value: "5" as unknown as number },
    { addr: A, value: 3 },
  ]), { [A]: "3" }));
ok("zero-value outputs still register the addr (value '0')", deepEq(paidToFromOutputs([{ addr: A, value: 0 }]), { [A]: "0" }));
// Null-proto accumulator (Plan 57 R1): a hostile addr named "__proto__" must land as an OWN key
// (a plain-object accumulator silently LOSES it to the prototype setter and emits "{}").
ok("addr named __proto__ lands as an own key (null-proto accumulator)",
  JSON.stringify(paidToFromOutputs([{ addr: "__proto__", value: 5 }])) === '{"__proto__":"5"}');

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
