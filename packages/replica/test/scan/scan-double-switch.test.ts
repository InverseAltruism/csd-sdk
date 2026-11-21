// A residual of M3-B1-03, documented in CHANGELOG.md (0.4.34) and AGENTS.md (Core flows): a switch to another
// branch and back inside one scan is not detected. When the indexer serves branch K for the read of the kept events'
// anchor block and branch A for the tip block's hash before it and the feed reads after it, the scan is accepted and
// its kept events keep K's row, which this scan and every later one serve until the kept events are replaced (the
// refresh after 40 accepted scans, any other scan that pulls in full, a restart) or rolled back below the row (a reorg
// of the anchor block while the row lies within 12 blocks of it). test/scan-kept-refresh.test.ts pins the same through
// a full pull.
import assert from "node:assert/strict";
import { Scanner, branchRefusal } from "../../src/scanner.js";
import { deploy, mint } from "@inversealtruism/cairnx-core";
import type { ChainEvent } from "@inversealtruism/cairnx-core";
import { A, B, H0, buildChain, type Spec } from "./scan-chain.js";

const top = H0 + 8;
const base: Spec[] = [{ kind: "propose", rec: deploy({ ticker: "DSW", decimals: 0, supply: "1000", mint: "open", mintLimit: "10" }), proposer: A, height: H0 }];
const K = buildChain([...base, { kind: "propose", rec: mint({ ticker: "DSW", amount: "3" }), proposer: B, height: top }]);
const onA: Spec[] = [...base, { kind: "propose", rec: mint({ ticker: "DSW", amount: "4" }), proposer: B, height: top + 1 }];
const chainA = buildChain(onA, { forks: [{ name: "A", from: top }] });
/** A with its tip block, the kept events' anchor after the split scan, mined again. */
const chainA2 = buildChain(onA, { forks: [{ name: "A", from: top }, { name: "A2", from: top + 1 }] });
const phantom = K.txs[1]!.txid;

type Read = "K" | "split" | "A" | "A, no feeds" | "A2";
const ids = (events: ChainEvent[]) => events.map((e) => (e.kind === "propose" ? e.id : e.txid));
const onChainA = ids((await new Scanner({ indexerUrl: "http://idx", fetch: chainA.indexer({ tip: top + 1 }) }).scan()).events);
assert.deepEqual(onChainA, [chainA.txs[0]!.txid, chainA.txs[1]!.txid], "setup: a fresh scanner on A serves A's rows only");

/** A scanner that kept K's events and then ran the split scan; each scan returns its event ids and whether it pulled in full. */
async function afterSplit() {
  const w = { read: "K" as Read, fullPulls: 0 };
  const f = (async (url: string) => {
    const p = new URL(url).pathname;
    if (p.startsWith("/domain/")) w.fullPulls++;
    if (w.read === "K" || (w.read === "split" && p === `/block-height/${top}`)) return K.indexer({ tip: top })(url);
    if (w.read === "A2") return chainA2.indexer({ tip: top + 1 })(url);
    return chainA.indexer({ tip: top + 1, feed: w.read !== "A, no feeds" })(url);
  }) as unknown as typeof fetch;
  const s = new Scanner({ indexerUrl: "http://idx", fetch: f });
  const scan = async (read: Read) => {
    w.read = read;
    w.fullPulls = 0;
    const r = await s.scan();
    assert.equal(branchRefusal(r.anchor), null, `${read}: the scan is accepted`);
    return { ids: ids(r.events), full: w.fullPulls > 0 };
  };
  assert.deepEqual((await scan("K")).ids, K.txs.map((x) => x.txid), "setup: the first scan keeps K's events");
  const split = await scan("split");
  assert.deepEqual(split, { ids: [onChainA[0], phantom, onChainA[1]], full: false }, "the split scan reads on from A's feeds and serves K's row, which is not on A");
  return scan;
}

let passed = 0;
const ok = (name: string) => { passed++; console.log("  ok", name); };
{
  const scan = await afterSplit();
  // the split scan was the kept events' second accepted scan (the first pulled K in full), so the 41st is the refresh
  for (let n = 3; n <= 40; n++) assert.deepEqual(await scan("A"), { ids: [onChainA[0], phantom, onChainA[1]], full: false }, `scan ${n} on A still serves K's row`);
  assert.deepEqual(await scan("A"), { ids: onChainA, full: true }, "scan 41 refreshes the kept events: a full pull, without K's row");
  assert.deepEqual(await scan("A"), { ids: onChainA, full: false }, "the next scan reads on from what the refresh kept");
  ok("the kept events keep the other branch's row, served by later scans until the refresh at the 41st accepted scan");
}
{
  const scan = await afterSplit();
  assert.deepEqual(await scan("A, no feeds"), { ids: onChainA, full: true }, "a scan that pulls in full serves A's rows only");
  assert.deepEqual(await scan("A"), { ids: onChainA, full: false }, "the next scan reads on from what that full pull kept");
  ok("a scan that pulls in full drops the row");
}
{
  const scan = await afterSplit();
  assert.deepEqual(await scan("A2"), { ids: onChainA, full: false }, "a reorg of the anchor block rolls the kept events back below the row");
  ok("a reorg of the anchor block while the row lies within 12 blocks of it rolls it back");
}
console.log(`scan-double-switch: ${passed} passed`);
