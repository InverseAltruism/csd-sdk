// The name-history selector ties each commit to the reveals that name it. Anyone can post many copies of one
// commitment hash and many reveals that name it (here an attacker's own, refused because the name is owned): keyed
// per commit and per reveal, the ties are their product (3,000 x 3,000 = 9,000,000 entries) before any pruning runs.
// Keyed once per commitment hash they are linear. Measured as the process's peak memory around one selection, in a
// file of its own so nothing else in the process sets that peak.
import assert from "node:assert/strict";
import { nameCommit } from "@inversealtruism/cairnx-core";
import { resolve } from "@inversealtruism/cairnx-core";
import { appliedIds, nameHistory } from "../src/namehist.js";
import { TREASURY_ADDR, V15_HEIGHT, V25_HEIGHT, nameRegFee, type CairnXRecord, type ChainEvent } from "@inversealtruism/cairnx-core";
import { fixtures } from "../src/factories.js";

const { prop } = fixtures({ expiryEpochs: 4, lower: true });
const A = "0x" + "aa".repeat(20), M = "0x" + "a7".repeat(20);
const reg = prop({ v: 1, t: "name", name: "alice" } as CairnXRecord, { proposer: A, height: V15_HEIGHT + 10, paidTo: { [TREASURY_ADDR]: nameRegFee("alice", V15_HEIGHT + 10).toString() } });
const salt = "5a".repeat(8);
const N = 3_000;
const events: ChainEvent[] = [reg];
for (let k = 0; k < N; k++) events.push(prop({ v: 1, t: "ncommit", commit: nameCommit("alice", salt, M) } as CairnXRecord, { proposer: M, height: V25_HEIGHT + 10 + k }));
for (let k = 0; k < N; k++) events.push(prop({ v: 1, t: "name", name: "alice", salt } as CairnXRecord, { proposer: M, height: V25_HEIGHT + 10 + N + k }));
const tip = V25_HEIGHT + 20 + 2 * N;

const peakMb = () => process.resourceUsage().maxRSS / 1024;   // kilobytes on Linux
const before = peakMb();
const selected = nameHistory(events, "alice");                  // the selection alone, every candidate
const grown = peakMb() - before;
console.log(`  peak memory grew ${grown.toFixed(1)} MB selecting ${selected.events.length} candidates`);
assert.ok(grown < 40, `selecting ${N} commits and ${N} reveals of one hash grew the peak by ${grown.toFixed(1)} MB`);
console.log("  ok copies of one commitment hash and reveals naming it cost memory linear in their number, not their product");

const st = resolve(events, tip);
const served = nameHistory(events, "alice", { tipHeight: tip, fullRecord: st.names["alice"], fullApplied: appliedIds(st.events) });
assert.deepEqual(served.events.map((e) => e.txid), [reg.id.toLowerCase()], "the refused reveals and the commits they name stay out of the hints");
assert.equal(served.scopedReplaySufficient, true);
console.log("  ok paired: the owner's registration is the one hint; the refused reveals and their commits are pruned");
console.log("namehist-commit-bound: 2 passed");
