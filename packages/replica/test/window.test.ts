// The header window and the reseed rule on csd-light's recorded mainnet headers (27,541 to 27,671, the input of its
// offline test), with workRoot at 27,585 and a window of 8. The headers are one chain, so a branch is a run of it
// offered again from a held block (as csd-light's own tryReorg tests offer them): a run that ends below the tip is
// less work, one that ends above it more. A branch with other bodies cannot be expressed by these headers; the loop's
// rows on a second branch are slice 2's (steps.test.ts, loop.test.ts) and hosted-blocks.test.ts.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { LWMA_WINDOW, headerHash, workForBits, type BlockHeader } from "@inversealtruism/csd-codec";
import { SourceError } from "../src/index.js";
import { HeaderWindow, type HeaderRow } from "../src/window.js";
import { done, ok, thrown } from "./check.js";

const light = join(dirname(createRequire(import.meta.url).resolve("@inversealtruism/csd-light")), "..");
const FX = JSON.parse(readFileSync(join(light, "test/fixtures-headers.json"), "utf8")) as { headers: HeaderRow[] };
const byH = new Map(FX.headers.map((r) => [r.height, { height: r.height, header: r.header, hash: r.hash }]));
const run = (a: number, b: number): HeaderRow[] => Array.from({ length: b - a + 1 }, (_, i) => byH.get(a + i)!);
const ROOT = { height: 27_585, hash: byH.get(27_585)!.hash }, SEED = run(27_541, 27_585), DEPTH = 8;
const workTo = (top: number) => run(ROOT.height + 1, top).reduce((w, r) => w + workForBits(r.header.bits), 0n);
const codeOf = (f: () => unknown) => { const e = thrown(f); return e instanceof SourceError ? `${e.code}${/PoW/.test(e.message) ? " (PoW)" : ""}` : e === null ? null : String(e); };
// A header mined again with another nonce: its hash is honest, its proof of work is not.
const remined = (r: HeaderRow): HeaderRow => { const header = { ...r.header, nonce: (r.header.nonce + 1) >>> 0 } as BlockHeader; return { height: r.height, header, hash: headerHash(header) }; };
const at = (top: number) => { const w = HeaderWindow.seed(SEED, ROOT, DEPTH); w.extend(run(ROOT.height + 1, top)); return w; };

console.log("seeded at workRoot:");
ok(`the recorded headers: ${FX.headers.length}, the seed the ${LWMA_WINDOW} ending at workRoot`, FX.headers.length === 131 && SEED.length === LWMA_WINDOW);
ok("a seed that does not end at workRoot's hash: PIN_OFF_CHAIN", codeOf(() => HeaderWindow.seed(run(27_542, 27_586), { height: 27_586, hash: ROOT.hash }, DEPTH)) === "PIN_OFF_CHAIN");
const badMid = SEED.map((r) => (r.height === 27_560 ? remined(r) : r));
ok("a seed header with bad proof of work: HEADER_INVALID on PoW", codeOf(() => HeaderWindow.seed(badMid, ROOT, DEPTH)) === "HEADER_INVALID (PoW)");
const w = at(27_640);
ok(`verified to 27,640: it holds ${LWMA_WINDOW} + ${DEPTH} headers, low is the tip less ${DEPTH}`, w.tip.height === 27_640 && w.at(27_640 - LWMA_WINDOW - DEPTH + 1) !== undefined &&
  w.at(27_640 - LWMA_WINDOW - DEPTH) === undefined && w.low === 27_632);
ok("work is counted from workRoot: the sum of each header's work above 27,585", w.work === workTo(27_640) && w.work > 0n);
const kept = HeaderWindow.seed(SEED, ROOT, DEPTH);
kept.extend(run(27_586, 27_640), 27_600);
ok("extend keeps a named block at or above low, and rewind drops what lies above it", kept.low === 27_600 && (kept.rewind(27_600), kept.tip.height === 27_600) && kept.work === workTo(27_600));
const bad = remined(byH.get(27_641)!);
ok("a header with bad proof of work: HEADER_INVALID on PoW, the window as it was", codeOf(() => w.extend([bad])) === "HEADER_INVALID (PoW)" && w.tip.height === 27_640);
const offRoot = HeaderWindow.seed(SEED, ROOT, DEPTH);
ok("a first header that names another parent than workRoot: PIN_OFF_CHAIN", codeOf(() => offRoot.extend([{ ...byH.get(27_587)!, height: 27_586 }])) === "PIN_OFF_CHAIN");

const reseat = HeaderWindow.seed(run(27_586, 27_630), { height: 27_630, hash: byH.get(27_630)!.hash }, DEPTH, { root: ROOT, work: workTo(27_630) });
reseat.extend(run(27_631, 27_640));
ok("a window seeded at a block verified from workRoot keeps counting work from workRoot", reseat.work === workTo(27_640) && reseat.root.height === ROOT.height);
ok("a later seed that does not end at its block's hash: HEADER_INVALID, not PIN_OFF_CHAIN",
  codeOf(() => HeaderWindow.seed(run(27_586, 27_630), { height: 27_630, hash: ROOT.hash }, DEPTH, { root: ROOT, work: 0n })) === "HEADER_INVALID");

console.log("a branch inside the window (csd-light tryReorg):");
const work0 = w.work;
ok("an equal-work branch (27,636 to 27,640 again): LESS_WORK, the window stays", codeOf(() => w.branch(run(27_636, 27_640))) === "LESS_WORK" && w.tip.height === 27_640 && w.work === work0);
ok("a lower-work branch (27,636 to 27,638): LESS_WORK, the window stays", codeOf(() => w.branch(run(27_636, 27_638))) === "LESS_WORK" && w.tip.height === 27_640 && w.work === work0);
ok("a branch from below low is not a branch of the window", thrown(() => w.branch(run(27_620, 27_660))) instanceof RangeError);
const badBranch = [...run(27_636, 27_641).slice(0, -1), bad];
ok("a branch whose last header has bad proof of work: HEADER_INVALID on PoW, the window stays", codeOf(() => w.branch(badBranch)) === "HEADER_INVALID (PoW)" && w.tip.height === 27_640);
ok("a higher-work branch (27,636 to 27,645): adopted, the fork block kept, work counted from workRoot",
  codeOf(() => w.branch(run(27_636, 27_645))) === null && w.tip.height === 27_645 && w.work === workTo(27_645) && w.hashAt(27_635) === byH.get(27_635)!.hash);

const thin = HeaderWindow.seed(SEED, ROOT, 1);
thin.extend(run(27_586, 27_620));
thin.branch(run(27_620, 27_671));
ok("a window of 1 adopting a branch 52 headers long from 27,619: the fork block stays held", thin.tip.height === 27_671 && thin.hashAt(27_619) === byH.get(27_619)!.hash);

console.log("a branch below the window, verified from workRoot (the reseed rule):");
const held = at(27_645), fresh = HeaderWindow.seed(SEED, ROOT, DEPTH);
fresh.extend(run(27_586, 27_644));
ok("a fresh window from the same seed to 27,644: less work than the held 27,645, not adopted", !fresh.outworks(held.work));
fresh.extend(run(27_645, 27_645));
ok("to 27,645: equal work, not adopted (a tie keeps the held chain)", fresh.work === held.work && !fresh.outworks(held.work));
fresh.extend(run(27_646, 27_650));
ok("to 27,650: more work, adopted", fresh.outworks(held.work) && fresh.work === workTo(27_650));

done("cairnx-replica window");
