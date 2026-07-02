// outputs -> paidTo aggregation (Plan 56 A.3 finding 2; Plan 57 B4). Every consumer that builds
// resolver ChainEvents from decoded tx outputs needs this exact aggregation (the cairnx service
// Scanner, the conformance/audit tools, third-party indexers); until now each re-rolled it.
// This is a verbatim mirror of the proven Scanner.paidTo (cairnx repo src/scan.ts, AUDIT L6);
// the scanner re-points here at a future re-pin. Contract notes are LOCAL by design:
//
// AUDIT L6 (DET-PAIDTO-1): values must be pre-validated non-negative safe-integer NUMBERS so the
// emitted string is always canonical decimal (JS BigInt and Python int() agree). The guard lives
// AT THE SINK so an alternate output source cannot reintroduce the cross-language fork
// (BigInt("0x2") = 2 while Python int("0x2") raises). Non-conforming outputs are SKIPPED, not
// thrown: byte-identical behavior to the scanner for every honest input.
export function paidToFromOutputs(outputs: readonly { addr: string; value: number }[]): Record<string, string> {
  // Null-prototype accumulator (Plan 57 R1): a strictly-safer divergence from the scanner's plain
  // object, and the one that matches Python dict semantics. Two hostile-addr edges change: an addr
  // literally named "__proto__" lands as an own key instead of being lost to the prototype setter,
  // and an addr named "constructor"/"toString" sums cleanly instead of throwing on BigInt(inherited
  // function). Unreachable with consensus-validated 0x-hex addrs; byte-identical output for every
  // honest input (JSON.stringify ignores the prototype either way). The scanner re-points here at
  // its re-pin, which retires the plain-object copy and the edge divergence with it.
  const m: Record<string, string> = Object.create(null);
  for (const o of outputs) {
    if (typeof o.value !== "number" || !Number.isSafeInteger(o.value) || o.value < 0) continue;
    m[o.addr] = (BigInt(m[o.addr] ?? "0") + BigInt(o.value)).toString();
  }
  return m;
}
