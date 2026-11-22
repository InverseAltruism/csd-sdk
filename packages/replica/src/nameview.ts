// The lease of a name and the detail of a name an address owns, as the resolver's /cairnx/name and /cairnx/address
// answer them: pure functions of a NameState and the tip's epoch (test/nameview.test.ts).
import { NAME_GRACE_EPOCHS } from "@inversealtruism/cairnx-core";
import type { NameState } from "@inversealtruism/cairnx-core";

// 1 epoch = 30 blocks, about an hour at 120 s blocks, so epochsLeft is about the hours left. paidThroughEpoch and
// expired exist only at tips past the gate that gave names a lease; before it a name had none.
export function leaseInfo(n: NameState, tipEpoch: number): Record<string, unknown> {
  if (n.paidThroughEpoch === undefined) return { leased: false };
  const paidThrough = n.paidThroughEpoch;
  const graceEnd = paidThrough + NAME_GRACE_EPOCHS;
  const lapsed = n.expired === true;                 // resolve() sets expired once tipEpoch > graceEnd
  const inGrace = !lapsed && tipEpoch > paidThrough;
  return {
    leased: true, paidThroughEpoch: paidThrough, graceEndEpoch: graceEnd,
    epochsLeft: paidThrough - tipEpoch,              // <= 0: in grace or lapsed
    graceEpochsLeft: lapsed ? 0 : graceEnd - tipEpoch,
    inGrace, lapsed,
  };
}

// The detail a wallet or an application shows for an owned name. `pending` is the field a client must read: a
// registration or recapture reservation is held under its owner but is not a finalized name, with no send address,
// no lease and no owner action until `nfinalize` (resolve() refuses nrenew and nset on a pending record, so offering
// either burns its fee). It is always a boolean, so the wire says false for a finalized name.
export function nameDetailsOf(n: NameState, tipEpoch: number) {
  return {
    name: n.name, addr: n.addr ?? null, locked: n.locked, viaFill: n.viaFill === true,
    pending: n.pending === true,
    // A reservation's on-chain expiry, so a client can show the block it must be finalized by; absent when finalized.
    ...(n.pending === true && n.finalizeBy !== undefined ? { finalizeBy: n.finalizeBy } : {}),
    height: n.height, effectiveHeight: n.effectiveHeight, ...leaseInfo(n, tipEpoch),
  };
}
