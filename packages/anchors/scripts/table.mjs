// The anchors table's one definition: its grid, its shape rules and its canonical text. The build, the generator and
// the wallet renderer read the table through here, and nothing else restates a rule.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CHUNK = 4096;
export const ACTIVATION_ROOT_HEIGHT = 29859;
export const HASH_RE = /^0x[0-9a-f]{64}$/;
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TABLE = join(ROOT, "anchors.json");

export const firstChunk = (floorHeight, chunk) => Math.floor(floorHeight / chunk);
export const topOf = (k, chunk) => k * chunk + chunk - 1;

const isAnchor = (a) => a !== null && typeof a === "object" && Number.isSafeInteger(a.height) && typeof a.hash === "string" && HASH_RE.test(a.hash);

/** The table, or a throw naming the first rule it breaks. `chunk` is the grid the table must be on. */
export function validateTable(t, chunk = CHUNK) {
  const list = Array.isArray(t?.anchors) ? t.anchors : [];
  const rules = [
    ["format must be 1", t?.format === 1],
    [`chunk must be ${chunk}`, t?.chunk === chunk],
    ["floor must be { height, hash } with a 0x and 64 lowercase hex hash", isAnchor(t?.floor)],
    [`activationRoot must be { height: ${ACTIVATION_ROOT_HEIGHT}, hash } with a 0x and 64 lowercase hex hash`, isAnchor(t?.activationRoot) && t.activationRoot.height === ACTIVATION_ROOT_HEIGHT],
    ["anchors must hold at least one { height, hash } with a 0x and 64 lowercase hex hash", list.length >= 1 && list.every(isAnchor)],
    [`every height must be a chunk top (${chunk}k + ${chunk - 1})`, list.every((a) => a.height % chunk === chunk - 1)],
    ["the floor must be below the first entry", list[0]?.height > t.floor.height],
    ["the first entry must be the first chunk top at or above the floor", list[0]?.height === topOf(firstChunk(t.floor.height, chunk), chunk)],
    [`heights must ascend by ${chunk}`, list.every((a, i) => i === 0 || a.height === list[i - 1].height + chunk)],
    ["no hash repeats", new Set(list.map((a) => a.hash)).size === list.length],
  ];
  const bad = rules.find(([, ok]) => !ok);
  if (bad) throw new Error(`anchors table refused: ${bad[0]}`);
  return t;
}

const row = (a) => `{ "height": ${a.height}, "hash": "${a.hash}" }`;

/** The canonical text of anchors.json: one entry per line, so a refresh adds one line per entry and a comma to the
 *  line of the entry before them. */
export const renderJson = (t) => `${[
  "{",
  `  "format": ${t.format},`,
  `  "chunk": ${t.chunk},`,
  `  "floor": ${row(t.floor)},`,
  `  "activationRoot": ${row(t.activationRoot)},`,
  '  "anchors": [',
  t.anchors.map((a) => `    ${row(a)}`).join(",\n"),
  "  ]",
  "}",
].join("\n")}\n`;

/** Why `next` does not extend `old` entry for entry (floor and activation root carried, no entry lost or changed), else null. */
export function extensionFault(old, next) {
  if (JSON.stringify(old.floor) !== JSON.stringify(next.floor)) return "the floor is not the committed one";
  if (JSON.stringify(old.activationRoot) !== JSON.stringify(next.activationRoot)) return "the activation root is not the committed one";
  const drift = old.anchors.findIndex((a, i) => next.anchors[i]?.height !== a.height || next.anchors[i]?.hash !== a.hash);
  return drift >= 0 ? `the new table does not extend the committed one (first difference at entry ${drift})` : null;
}

/** Strict parse: the text must be valid and be exactly its own canonical rendering, so a hand edit is refused. */
export function parseTable(text, chunk = CHUNK) {
  let t;
  try { t = JSON.parse(text); } catch { throw new Error("anchors table refused: not JSON"); }
  validateTable(t, chunk);
  if (renderJson(t) !== text) throw new Error("anchors table refused: not the canonical text of its own data (hand-edited?)");
  return t;
}
