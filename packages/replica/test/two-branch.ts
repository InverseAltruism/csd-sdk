// A two-branch header chain csd-light accepts, mined at the chain's easiest target for this purpose (one run, the
// review of 2026-11-18): a seed 1041 to 1085 (the anchor, workRoot), branch A 1086 to 1089 at 60 s spacing and
// branch B 1086 to 1091 at 120 s. A carries more work a block: above the anchor A to 1089 is 69,661,988, B to 1089
// 67,109,888, B to 1090 83,887,360. Every header commits the merkle root of block 30,300's one transaction, so each
// block's body is that block's, and the rule activates at 1086 (anchor = activation less one). Blocks 1024 to 1040
// are filler for the aligned page from 1024: hash-consistent rows below the anchor that nothing binds.
import { readFileSync } from "node:fs";
import { CAIRNX_EVENT_RULE, type EventRule } from "@inversealtruism/cairnx-core";
import { headerHash, type BlockHeader } from "@inversealtruism/csd-codec";
import { blockAt, cap, type Answers } from "./node-harness.js";

export type Row = { height: number; header: BlockHeader; hash: string };
export const CHAIN = new URL("./fixtures/two-branch-headers.json", import.meta.url), chainBytes = readFileSync(CHAIN);
export const chain = JSON.parse(chainBytes.toString("utf8")) as { seed: Row[]; A: Row[]; B: Row[] };
export const ANCHOR = { height: 1085, hash: chain.seed.at(-1)!.hash }, RULE: EventRule = { ...CAIRNX_EVENT_RULE, activationHeight: 1086 };
export const A = (h: number) => chain.A[h - 1086]!.hash, B = (h: number) => chain.B[h - 1086]!.hash;
const txs = blockAt(cap.answers, 30_300).txs;
const blk = (r: Row) => JSON.stringify({ ok: true, height: r.height, hash: r.hash, chainwork: "0", header: r.header, txs });
const filler: Answers = {};
for (let h = 1024; h <= 1040; h++) { const header = { ...chain.seed[0]!.header, nonce: h }; filler[`/block/height/${h}`] = blk({ height: h, header, hash: headerHash(header) }); }
const of = (rows: Row[]): Answers => ({ ...filler, ...Object.fromEntries([...chain.seed, ...rows].map((r) => [`/block/height/${r.height}`, blk(r)])) });
export const onA = of(chain.A), onB = of(chain.B);
/** The header rows of `rows` as /api/headers answers them. */
export const headerAnswer = (rows: Row[]) => JSON.stringify({ ok: true, from: rows[0]!.height, count: rows.length, headers: rows.map((r) => ({ height: r.height, header: r.header, hash: r.hash })) });
