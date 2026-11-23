// The basis rule: every combination of a root, a body source and a pin the design lists, with its level and proof or
// its refusal; the store name each basis gets; the code tables; and the compile-time refusal of a pin over a feed.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NOTE_CODES, NOT_VERIFIED_CODES, ReplicaConfigError, basisKey, checkBasis, levelOf, proofOf, type Basis, type RecordProof,
} from "../src/index.js";
import { keepsStore } from "../src/basis.js";
import { done, ok, thrown } from "./check.js";

const h = (c: string) => `0x${c.repeat(64)}`;
const PIN = { height: 117_000, hash: h("a") }, PIN2 = { height: 117_030, hash: h("d") }, LOG = h("b"), LOG2 = h("e");
const node = { kind: "own-node", node: "http://127.0.0.1:8789" } as const;
const anchor = (c: { height: number; hash: string }) => ({ kind: "anchor", anchor: c }) as const;
const caller = { kind: "caller", floor: 29_960, origin: "https://headers.example" } as const;
const blocks = (root: unknown, bodies = "https://blocks.example") => ({ kind: "blocks", root, bodies });
const pinned = (above: unknown, pin: unknown = PIN, logSha256: unknown = LOG) => ({ kind: "pinned", pin, logSha256, above });
const display = { kind: "display", origin: "https://api.example" };
const feed = (inclusion: boolean) => ({ kind: "feed", feed: "https://feed.example", inclusion });
const A0 = { height: 29_859, hash: h("c") };

console.log("levels and refusals:");
const ROWS: [string, unknown, 1 | 2 | 3 | RegExp, RecordProof?][] = [
  ["a display", display, 1, "served"],
  ["a feed", feed(false), 1, "served"],
  ["a feed with inclusion proofs", feed(true), 2, "inclusion"],
  ["blocks on an own-node root", blocks(node), 3, "inclusion"],
  ["blocks on an anchor root", blocks(anchor(A0)), 3, "inclusion"],
  ["blocks on a caller root", blocks(caller), 3, "inclusion"],
  ["a pin over blocks on an own-node root", pinned(blocks(node)), 3, "pinned"],
  ["a pin over blocks anchored at the pin", pinned(blocks(anchor(PIN))), 3, "pinned"],
  ["a pin over blocks on a caller root", pinned(blocks(caller)), 3, "pinned"],
  ["a pin over a feed", pinned(feed(false)), /only blocks sit above a pin, not feed/],
  ["a pin over a feed with inclusion proofs", pinned(feed(true)), /only blocks sit above a pin, not feed/],
  ["a pin over a display", pinned(display), /only blocks sit above a pin, not display/],
  ["a pin over a pin", pinned(pinned(blocks(node))), /only blocks sit above a pin, not pinned/],
  ["a pin over nothing", pinned(undefined), /only blocks sit above a pin, not undefined/],
  ["a pin over blocks anchored elsewhere", pinned(blocks(anchor(A0))), /an anchor root under a pin is the pin/],
  ["a pin over blocks anchored at the pin's height on another hash", pinned(blocks(anchor({ ...PIN, hash: h("f") }))), /anchor root under a pin is the pin/],
  ["an unknown kind", { kind: "node-events", node: "http://127.0.0.1:8789" }, /kind node-events is unknown/],
  ["an unknown root", blocks({ kind: "trusted" }), /root kind trusted is unknown/],
  ["blocks without bodies", { kind: "blocks", root: node }, /bodies is not a non-empty string/],
  ["a feed without its inclusion flag", { kind: "feed", feed: "https://feed.example" }, /inclusion is not a boolean/],
  ["a display with an empty origin", { kind: "display", origin: "" }, /origin is not a non-empty string/],
  ["a caller root with a fractional floor", blocks({ ...caller, floor: 29_960.5 }), /root.floor is not a safe integer/],
  ["a pin hash in upper case", pinned(blocks(node), { height: 117_000, hash: `0x${"A".repeat(64)}` }), /pin.hash is not 0x and 64 lowercase hex/],
  ["a log hash without 0x", pinned(blocks(node), PIN, "b".repeat(64)), /logSha256 is not 0x/],
  ["not an object", null, /basis: not an object/],
];
for (const [name, b, want, proof] of ROWS) {
  if (want instanceof RegExp) {
    const all = [checkBasis, levelOf, proofOf, basisKey].map((f) => thrown(() => f(b as Basis)));
    ok(`${name}: refused by checkBasis, levelOf, proofOf and basisKey`,
      all.every((e) => e instanceof ReplicaConfigError && want.test(e.message)), all.map((e) => String(e)).join("; "));
  } else {
    ok(`${name}: level ${want}, proof ${proof}`,
      levelOf(b as Basis) === want && proofOf(b as Basis) === proof && JSON.stringify(checkBasis(b)) === JSON.stringify(b));
  }
}
const extra = checkBasis({ ...pinned(blocks(node)), level: 3, above: { ...blocks(node), trusted: true } });
ok("checkBasis keeps only a basis's own fields", JSON.stringify(extra) === JSON.stringify(pinned(blocks(node))));

console.log("store names:");
const K = (b: unknown) => basisKey(b as Basis);
ok("a pin's name leaves out the pin and its log",
  K(pinned(blocks(node))) === '{"above":{"bodies":"https://blocks.example","kind":"blocks","root":{"kind":"own-node","node":"http://127.0.0.1:8789"}},"kind":"pinned"}');
ok("an anchor root under a pin is named without the anchor",
  K(pinned(blocks(anchor(PIN)))) === '{"above":{"bodies":"https://blocks.example","kind":"blocks","root":{"kind":"anchor"}},"kind":"pinned"}');
ok("a feed's name is its canonical JSON", K(feed(true)) === '{"feed":"https://feed.example","inclusion":true,"kind":"feed"}');
const PAIRS: [string, unknown, unknown, boolean][] = [
  ["a newer pin over the same own-node root and bodies", pinned(blocks(node)), pinned(blocks(node), PIN2, LOG2), true],
  ["a newer pin over blocks anchored at each pin", pinned(blocks(anchor(PIN))), pinned(blocks(anchor(PIN2)), PIN2, LOG2), true],
  ["a newer pin over the same caller root", pinned(blocks(caller)), pinned(blocks(caller), PIN2, LOG2), true],
  ["another log at the same pin height", pinned(blocks(node)), pinned(blocks(node), PIN, LOG2), true],
  ["another body origin under a pin", pinned(blocks(node)), pinned(blocks(node, "https://other.example")), false],
  ["another own node under a pin", pinned(blocks(node)), pinned(blocks({ kind: "own-node", node: "http://[::1]:8789" })), false],
  ["another caller floor", pinned(blocks(caller)), pinned(blocks({ ...caller, floor: 30_000 })), false],
  ["another caller origin", pinned(blocks(caller)), pinned(blocks({ ...caller, origin: "https://other.example" })), false],
  ["an own-node root, then an anchor root under a pin", pinned(blocks(node)), pinned(blocks(anchor(PIN))), false],
  ["blocks, then a pin over the same blocks", blocks(node), pinned(blocks(node)), false],
  ["a feed, then a pin over blocks", feed(true), pinned(blocks(node)), false],
  ["a feed without, then with inclusion proofs", feed(false), feed(true), false],
  ["blocks on another anchor", blocks(anchor(A0)), blocks(anchor({ ...A0, hash: h("9") })), false],
  ["another display origin", display, { kind: "display", origin: "https://other.example" }, false],
];
for (const [name, a, b, same] of PAIRS) ok(`${name}: ${same ? "same" : "another"} store`, (K(a) === K(b)) === same);

console.log("the store kept across a newer pin (keepsStore), each condition broken alone:");
// The rows a store holds up to `top`, giving at `height` (default PIN2's) the values `at` names; the readers do not stop
// at the cursor, so the cursor condition is the predicate's own.
const EV2 = h("7"), honestAt = { hash: PIN2.hash, eventsHash: EV2, log: LOG2 };
const rowsTo = (top: number, at: Partial<typeof honestAt> = {}, height = PIN2.height) => {
  const v = { ...honestAt, ...at }, here = (x: number) => x === height;
  return { cursor: { height: top, hash: h("9") }, hashAt: (x: number) => (here(x) ? v.hash : null), eventsHashAt: (x: number) => (here(x) ? v.eventsHash : null),
    logSha256At: (x: number) => (here(x) ? v.log : null) };
};
const keeps = (stored: unknown, wanted: unknown, rows = rowsTo(PIN2.height + 10), ev: string | null = EV2) => keepsStore(stored as Basis, wanted as Basis, ev, rows);
const P1 = pinned(blocks(node)), P2 = pinned(blocks(node), PIN2, LOG2);
ok("the honest case: one key, a higher pin, the cursor above it, the rows giving its block hash, events hash and log digest: kept", keeps(P1, P2));
ok("the cursor at the new pin itself: kept", keeps(P1, P2, rowsTo(PIN2.height)));
const BROKEN: [string, boolean][] = [
  ["another body origin under the newer pin (another key)", keeps(P1, pinned(blocks(node, "https://other.example"), PIN2, LOG2))],
  ["an own-node store, then a newer pin over an anchor root (another key)", keeps(P1, pinned(blocks(anchor(PIN2)), PIN2, LOG2))],
  ["blocks without a pin, then a pin (another key)", keeps(blocks(node), P2)],
  ["the same height with another log, the rows giving it", keeps(P1, pinned(blocks(node), PIN, LOG2), rowsTo(PIN.height + 10, { hash: PIN.hash }, PIN.height))],
  ["an older pin, the rows giving it", keeps(P2, P1, rowsTo(PIN2.height + 10, { hash: PIN.hash, log: LOG }, PIN.height))],
  ["the cursor below the new pin", keeps(P1, P2, rowsTo(PIN2.height - 1))],
  ["another block hash at the new pin", keeps(P1, P2, rowsTo(PIN2.height + 10, { hash: h("8") }))],
  ["another events hash at the new pin", keeps(P1, P2, rowsTo(PIN2.height + 10, { eventsHash: h("8") }))],
  ["a source that names no pin's events hash", keeps(P1, P2, rowsTo(PIN2.height + 10), null)],
  ["another log digest at the new pin", keeps(P1, P2, rowsTo(PIN2.height + 10, { log: h("8") }))],
];
for (const [name, kept] of BROKEN) ok(`${name}: not kept`, kept === false);

console.log("code tables:");
const upper = (codes: readonly string[]) => codes.every((c) => /^[A-Z]+(?:_[A-Z]+)*$/.test(c)) && new Set(codes).size === codes.length;
ok("19 not-verified codes, distinct", NOT_VERIFIED_CODES.length === 19 && upper(NOT_VERIFIED_CODES) && Object.isFrozen(NOT_VERIFIED_CODES));
ok("14 note codes, distinct, none a not-verified code", NOTE_CODES.length === 14 && upper(NOTE_CODES) && Object.isFrozen(NOTE_CODES) &&
  NOTE_CODES.every((c) => !(NOT_VERIFIED_CODES as readonly string[]).includes(c)));

console.log("compile-time refusal:");
const here = dirname(fileURLToPath(import.meta.url));
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
const r = spawnSync(process.execPath, [tsc, "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--target", "ES2022", "--module", "ESNext",
  "--moduleResolution", "Bundler", "--skipLibCheck", join(here, "fixtures", "basis-types.ts")], { encoding: "utf8" });
ok("tsc over fixtures/basis-types.ts is clean: a pin over a feed, a display or a pin does not compile, the lawful bases do",
  r.status === 0, `${r.stdout}${r.stderr}`);

done("cairnx-replica basis");
