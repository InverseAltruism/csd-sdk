// nameview (taken from the resolver's test/nameview.test.ts at cairnx 0c95ad2): the name detail of /cairnx/address and
// the lease of /cairnx/name. A reservation (a `pending` name, held under its owner between the payment-free reveal and
// the winner's nfinalize) is flagged `pending: true` and carries no lease, so a client shows it as finalizing and
// offers no renew or set primary on it; a finalized name flips `pending` to false. The states come from cairnx-core's
// resolve().
import {
  nameCommit, nameCommitRecord, nameClaim, nameFinalize, epochOf, resolve,
  REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS, V25_HEIGHT, TREASURY_ADDR, nameRegFee, type ChainEvent,
} from "@inversealtruism/cairnx-core";
import { fixtures } from "../src/factories.js";
import { leaseInfo, nameDetailsOf } from "../src/index.js";
import { done, ok } from "./check.js";

const A = "0x" + "a5".repeat(20);
const { prop } = fixtures();
const NAME = "reserva", SALT = "a5cafe00b17e1234a5cafe00b17e1234";
const commitH = V25_HEIGHT + 10, revealH = commitH + 2;
const baseEvents: ChainEvent[] = [
  prop(nameCommitRecord({ commit: nameCommit(NAME, SALT, A) }).record, { proposer: A, height: commitH }),
  prop(nameClaim({ name: NAME, salt: SALT }).record, { proposer: A, height: revealH, paidTo: {} }),   // a payment-free reveal: a pending reservation
];
const finalizeH = revealH + REG_COMMIT_MAX_BLOCKS + 1;   // past the freeze, inside the grace window
const finalized = (): ChainEvent[] => [...baseEvents,
  prop(nameFinalize({ name: NAME, salt: SALT }).record, { proposer: A, height: finalizeH, paidTo: { [TREASURY_ADDR]: nameRegFee(NAME, finalizeH).toString() } })];

console.log("a reservation:");
{
  const tip = revealH + 1, st = resolve(baseEvents, tip), n = st.names[NAME];
  ok("a revealed, unfinalized name is a pending reservation under its owner, with no lease", n !== undefined &&
    n.owner.toLowerCase() === A.toLowerCase() && n.pending === true && n.paidThroughEpoch === undefined);
  const d = nameDetailsOf(n!, epochOf(tip)) as Record<string, unknown>;
  ok("nameDetailsOf flags it pending, not leased, with no send address", d.pending === true && d.leased === false && d.addr === null);
  ok("and carries its finalizeBy (the commit's height plus the window and the grace)", d.finalizeBy === commitH + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS);
}

console.log("after nfinalize:");
{
  ok("the finalize lands within the grace", finalizeH <= revealH + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS);
  const tip = finalizeH + 1, st = resolve(finalized(), tip), n = st.names[NAME];
  ok("the same name is a leased name of its owner, not pending", n !== undefined && n.owner.toLowerCase() === A.toLowerCase() && n.pending !== true);
  const d = nameDetailsOf(n!, epochOf(tip)) as Record<string, unknown>;
  ok("nameDetailsOf says pending false, leased true, and no finalizeBy", d.pending === false && d.leased === true && d.finalizeBy === undefined);
  const li = leaseInfo(n!, epochOf(tip));
  ok("leaseInfo of a leased name: leased, with its paid-through epoch", li.leased === true && typeof li.paidThroughEpoch === "number");
}

done("cairnx-replica nameview");
