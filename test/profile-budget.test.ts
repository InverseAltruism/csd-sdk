// scripts/profile-budget.mjs against the byte budget and the key registry of packages/cairnx/CONVENTION.md §36.
// Needs the built packages (pnpm -r build). Run: pnpm exec tsx test/profile-budget.test.ts   (offline)
import { readFileSync } from "node:fs";
import { MAX_RECORD_BYTES, PKEY, PROFILE_MAX_KEYS, nameProfile, parseRecord } from "../packages/cairnx/dist/index.js";
import { budgetRows, EDITOR_KEYS, GATEWAY, keyCount, NAME, VALUES } from "../scripts/profile-budget.mjs";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, detail = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}${c || !detail ? "" : `\n      ${detail}`}`); };

const spec = readFileSync(new URL("../packages/cairnx/CONVENTION.md", import.meta.url), "utf8");
const section = (from: string, to: string) => {
  const a = spec.indexOf(from), b = spec.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`CONVENTION.md has no section between "${from}" and "${to}"`);
  return spec.slice(a, b);
};
const utf8 = (s: string) => new TextEncoder().encode(s).length;
const rows = budgetRows();

console.log("profile-budget:");
ok("the example name is 32 characters, the longest name", NAME.length === 32);
ok("the gateway example is 158 bytes", utf8(GATEWAY) === 158, String(utf8(GATEWAY)));

const budget = section("### 36.4 The byte budget", "### 36.5");
const table = budget.split("\n").filter((l) => /^\| /.test(l) && !/^\| Profile /.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
const parsed = table.map(([label = "", keys = "", bytes = "", left = ""]) => {
  const over = /^(\d+) over: `nameProfile` refuses it$/.exec(left);
  return { label: label.replaceAll("`", ""), keys: Number(keys), bytes: Number(bytes), left: over ? -Number(over[1]) : Number(left) };
});
const want = rows.map(({ label, keys, bytes, left }) => ({ label, keys, bytes, left }));
ok("the table in §36.4 equals the script's rows", JSON.stringify(parsed) === JSON.stringify(want),
  `spec:   ${JSON.stringify(parsed)}\n      script: ${JSON.stringify(want)}`);
ok("every row that fits is built, and every row over the cap is refused",
  rows.every((r) => r.builds === (r.bytes <= MAX_RECORD_BYTES)), JSON.stringify(rows));
ok("a refused row is refused for its bytes alone: its keys are within the key cap",
  rows.filter((r) => !r.builds).every((r) => r.keys <= PROFILE_MAX_KEYS));
const sizes: Array<[string, number]> = [
  ["`contenthash` a CIDv1 in base32, ", utf8(VALUES.contenthash)], ["`csd.p2p` a DNS multiaddr with an Ed25519 peer id, ", utf8(VALUES["csd.p2p"])],
  ["`csd.rpc` an https base URL, ", utf8(VALUES["csd.rpc"])], ["a WebRTC gateway multiaddr with a certificate hash and a peer id, ", utf8(GATEWAY)],
  ["each editor key ", 12],
];
for (const [lead, n] of sizes) {
  ok(`§36.4 states the example size "${lead}${n} bytes"`, budget.replace(/\n/g, " ").includes(`${lead}${n} bytes`));
}
ok("13 editor keys and the three registered keys are the key cap exactly", keyCount() === PROFILE_MAX_KEYS && EDITOR_KEYS.length === 13);

const registry = section("### 36.2 The keys", "### 36.3");
const editorRow = registry.split("\n").find((l) => l.includes("profile editor writes")) ?? "";
const listed = [...(editorRow.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
ok("the editor keys of §36.2 are the script's", JSON.stringify(listed) === JSON.stringify(EDITOR_KEYS), listed.join(", "));
ok("every registered key matches PKEY", [...EDITOR_KEYS, ...Object.keys(VALUES)].every((k) => PKEY.test(k)));

// The honest path: a profile with the registered keys and realistic values builds and parses as a record.
const built = nameProfile({ name: NAME, p: { ...VALUES } });
ok("the registered keys with the example values build and parse", parseRecord(built.uri, built.payloadHash) !== null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
