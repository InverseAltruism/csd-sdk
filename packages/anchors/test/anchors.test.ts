// The shipped table: shape and grid, equality with the wallet's table as it shipped (the copy of its two generated
// files in fixtures/), the wallet files rendered from it byte for byte, the floor and the activation root against the
// recorded blocks the replica's tests hold, the build and its refusals, and the module the package exports. What an
// entry is on the chain is not checked here: the generator's --check does that against a headers source and a second
// RPC (generate.test.ts runs it against stubs).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headerHash } from "@inversealtruism/csd-codec";
import { done, ok, thrown } from "../../replica/test/check.js";
import { ANCHORS } from "../dist/index.js";
import { builder, tableMod, wallet, type Anchor, type Table } from "./scripts.js";

const here = (p: string) => new URL(p, import.meta.url);
const read = (p: string) => readFileSync(here(p), "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const why = (fn: () => unknown) => { const e = thrown(fn); return e instanceof Error ? e.message : ""; };
const text = read("../anchors.json"), table = tableMod.parseTable(text);
const pkg = JSON.parse(read("../package.json")) as { name: string; version: string; private?: boolean; exports: Record<string, unknown> } & Record<string, unknown>;

console.log("the table is the wallet's, as it shipped:");
// cairn-wallet origin/master at its 0.3.4 release: src/core/spvanchors.ts and src/core/spvnewest.ts, copied byte for byte.
const WALLET_COMMIT = "39882ed95a8064e9b2d148192967d7f12fc2b361";
const walletAnchors = read("./fixtures/wallet-spvanchors.txt"), walletNewest = read("./fixtures/wallet-spvnewest.txt");
ok(`the fixtures are the wallet's two files at ${WALLET_COMMIT.slice(0, 7)} (sha256 5b79a4a4..., d7c4a453...)`,
  sha(walletAnchors) === "5b79a4a4a5ea0aa0d1bc1a57b897324e5e0c4a72dd508a8591c040cc71f99c57" && sha(walletNewest) === "d7c4a453e43bd8439e304acd81618707a2005d84bcc28713309124346d1cbbc3");
// Read from the wallet's text with its own shape (not through the renderer), so the comparison is not circular.
const fl = /export const SPV_FLOOR = \{ height: (\d+), hash: "(0x[0-9a-f]{64})" \} as const;/.exec(walletAnchors);
const walletEntries = [...walletAnchors.matchAll(/^ {2}"(0x[0-9a-f]{64})", \/\/ (\d+)$/gm)].map((m): Anchor => ({ height: Number(m[2]), hash: m[1]! }));
const walletChunk = Number(/export const SPV_CHUNK = (\d+);/.exec(walletAnchors)?.[1]);
ok("the floor, the chunk and each of the entries (hash and height) equal the wallet's",
  fl !== null && table.floor.height === Number(fl[1]) && table.floor.hash === fl[2] && table.chunk === walletChunk &&
  JSON.stringify(table.anchors) === JSON.stringify(walletEntries));
ok(`the wallet's table has 28 entries from 32,767 to 143,359 on the 4,096 grid, floor 29,960 (${walletEntries.length} read)`,
  walletEntries.length === 28 && walletEntries[0]?.height === 32_767 && walletEntries.at(-1)?.height === 143_359 && walletChunk === 4096 && table.floor.height === 29_960);
ok("the renderer gives the wallet's spvanchors.ts byte for byte", wallet.renderSpvAnchors(table) === walletAnchors);
ok("the renderer gives the wallet's spvnewest.ts byte for byte", wallet.renderSpvNewest(table) === walletNewest);
const cli = (which: string) => spawnSync(process.execPath, [new URL("../scripts/render-wallet.mjs", import.meta.url).pathname, which], { encoding: "utf8" });
ok("the script as the wallet will call it prints both files byte for byte", cli("anchors").stdout === walletAnchors && cli("newest").stdout === walletNewest);
ok("the script refuses an unknown file name, exit 2", cli("everything").status === 2);
ok("the renderer refuses a table that fails the shape rules", /ascend/.test(why(() => wallet.renderSpvAnchors({ ...table, anchors: table.anchors.filter((_, i) => i !== 10) }))));

console.log("the floor and the activation root are blocks of the chain:");
type Block = { height: number; hash: string; header: { version: number; prev: string; merkle: string; time: number; bits: number; nonce: number } };
const blockOf = (file: string, h: number): Block => JSON.parse((JSON.parse(read(file)) as { answers: Record<string, string> }).answers[`/block/height/${h}`]!) as Block;
const rehash = (b: Block) => headerHash(b.header).toLowerCase();
const root = blockOf("../../replica/test/fixtures/node-blocks-29815-29859.json", 29_859), floor = blockOf("../../replica/test/fixtures/node-blocks-29860-30300.json", 29_960);
ok("the activation root is the hash of the recorded header at 29,859, re-derived from its fields",
  table.activationRoot.height === tableMod.ACTIVATION_ROOT_HEIGHT && root.height === 29_859 && rehash(root) === root.hash && root.hash === table.activationRoot.hash);
ok("the floor is the hash of the recorded header at 29,960, re-derived from its fields",
  floor.height === table.floor.height && rehash(floor) === floor.hash && floor.hash === table.floor.hash);

console.log("the shape rules, each refused alone:");
const bad = (name: string, edit: (t: Table) => void, re: RegExp) => {
  const t = structuredClone(table); edit(t);
  const m = why(() => tableMod.validateTable(t));
  ok(`refused: ${name}`, re.test(m), m);
};
const upper = (h: string) => `0x${h.slice(2).toUpperCase()}`;
ok("the committed table passes: grid heights ascending by 4,096 from the first entry, every height 4,096k + 4,095, the floor below the first entry, the activation root at 29,859, lowercase hashes, no repeat",
  tableMod.validateTable(table) === table && table.anchors.every((a, i) => a.height === 4096 * (7 + i) + 4095 && tableMod.HASH_RE.test(a.hash)) && table.floor.height < table.anchors[0]!.height);
bad("format 2", (t) => { (t as { format: number }).format = 2; }, /format must be 1/);
bad("chunk 2048", (t) => { t.chunk = 2048; }, /chunk must be 4096/);
bad("a floor hash in upper case", (t) => { t.floor.hash = upper(t.floor.hash); }, /floor must be/);
bad("an activation root at 29,860", (t) => { t.activationRoot.height = 29_860; }, /activationRoot must be/);
bad("an activation root hash of 63 digits", (t) => { t.activationRoot.hash = t.activationRoot.hash.slice(0, -1); }, /activationRoot must be/);
bad("no entry", (t) => { t.anchors = []; }, /at least one/);
bad("an entry hash in upper case", (t) => { t.anchors[4]!.hash = upper(t.anchors[4]!.hash); }, /at least one/);
bad("an entry one block off the grid", (t) => { t.anchors[3]!.height += 1; }, /chunk top/);
bad("an entry removed from the middle", (t) => { t.anchors.splice(10, 1); }, /ascend/);
bad("the first entry removed", (t) => { t.anchors.shift(); }, /first chunk top/);
bad("a floor at the first entry's height", (t) => { t.floor.height = t.anchors[0]!.height; }, /floor must be below/);
bad("a floor one chunk lower (the first entry is no longer the first chunk top at or above it)", (t) => { t.floor.height -= 4096; }, /first chunk top/);
bad("a hash repeated", (t) => { t.anchors[5]!.hash = t.anchors[4]!.hash; }, /no hash repeats/);

console.log("a refresh extends the table:");
const prevFile = here("./previous-published.json");
if (existsSync(prevFile)) {
  const prev = tableMod.parseTable(readFileSync(prevFile, "utf8"));
  ok("the table extends the previous published one entry for entry, floor and activation root carried", tableMod.extensionFault(prev, table) === null);
} else {
  ok(`no table has been published, which only the first version may say (this is ${pkg.version}); from the next version on previous-published.json must exist`, pkg.version === "0.1.0");
}
const more = structuredClone(table);
more.anchors.push({ height: 147_455, hash: `0x${"ab".repeat(32)}` });
ok("the rule accepts a table with one entry added", tableMod.extensionFault(table, more) === null);
const edited = structuredClone(more); edited.anchors[3]!.hash = `0x${"cd".repeat(32)}`;
ok("the rule refuses a changed entry, naming it", /entry 3\)/.test(tableMod.extensionFault(table, edited) ?? ""));
ok("the rule refuses a lost last entry, naming it", /entry 27\)/.test(tableMod.extensionFault(table, { ...table, anchors: table.anchors.slice(0, 27) }) ?? ""));
const shifted = structuredClone(more); shifted.anchors[3]!.height += 4096;
ok("the rule refuses an entry kept at another height, naming it", /entry 3\)/.test(tableMod.extensionFault(table, shifted) ?? ""));
const moved = structuredClone(more); moved.floor.hash = `0x${"ef".repeat(32)}`;
ok("the rule refuses a floor that is not the committed one", /floor/.test(tableMod.extensionFault(table, moved) ?? ""));
const rerooted = structuredClone(more); rerooted.activationRoot.hash = `0x${"12".repeat(32)}`;
ok("the rule refuses an activation root that is not the committed one", /activation root/.test(tableMod.extensionFault(table, rerooted) ?? ""));

console.log("the build and the module:");
const tmp = mkdtempSync(join(tmpdir(), "anchors-build-"));
const rootWith = (name: string, body: string) => { const d = join(tmp, name); mkdirSync(d); writeFileSync(join(d, "anchors.json"), body); return d; };
const built = rootWith("ok", text);
ok("the build of the committed text passes and writes the module the package exports, byte for byte", builder.build(built).anchors.length === 28 &&
  readFileSync(join(built, "dist/index.js"), "utf8") === read("../dist/index.js") && readFileSync(join(built, "dist/index.d.ts"), "utf8") === read("../dist/index.d.ts"));
const refusedBuild = (name: string, body: string, re: RegExp) => { const m = why(() => builder.build(rootWith(name, body))); ok(`the build refuses ${name}`, re.test(m), m); };
refusedBuild("a hash in upper case", text.replace(table.anchors[0]!.hash, upper(table.anchors[0]!.hash)), /at least one/);
refusedBuild("an entry removed from the middle", tableMod.renderJson({ ...table, anchors: table.anchors.filter((_, i) => i !== 10) }), /ascend/);
refusedBuild("a hand-edited file whose data is valid", text.replace('"format": 1', '"format":  1'), /canonical text/);
refusedBuild("text that is not JSON", "{", /not JSON/);
rmSync(tmp, { recursive: true, force: true });
const frozen = (v: unknown): boolean => typeof v !== "object" || v === null || (Object.isFrozen(v) && Object.values(v).every(frozen));
ok("ANCHORS is anchors.json", JSON.stringify(ANCHORS) === JSON.stringify(table));
ok("ANCHORS is frozen at every level, and a write to it throws", frozen(ANCHORS) && thrown(() => (ANCHORS.anchors as Anchor[]).push(table.floor)) instanceof TypeError);

console.log("the package:");
const field = (p: Record<string, unknown>, f: string) => Object.keys((p[f] as object | undefined) ?? {});
ok("private, with no runtime dependency, and exports the module and the data file",
  pkg.private === true && pkg.name === "@inversealtruism/csd-anchors" && ["dependencies", "peerDependencies", "optionalDependencies"].every((f) => field(pkg, f).length === 0) &&
  Object.keys(pkg.exports).join() === ".,./anchors.json");
const manifests = ["../../../package.json", ...readdirSync(here("../../"), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "anchors").map((d) => `../../${d.name}/package.json`)];
const dependents = manifests.filter((m) => ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some((f) => field(JSON.parse(read(m)) as Record<string, unknown>, f).includes(pkg.name)));
ok(`no package in the workspace depends on it (${manifests.length} manifests read)`, manifests.length >= 10 && dependents.length === 0, dependents.join(", "));
const literals = readdirSync(here("../scripts/")).filter((f) => /0x[0-9a-f]{64}/.test(read(`../scripts/${f}`)));
ok("no script holds a hash: the data lives in anchors.json alone", literals.length === 0, literals.join(", "));
done("csd-anchors shipped");
