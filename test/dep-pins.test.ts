// Every dependency and devDependency of the root and of each workspace package is either `workspace:*` or an exact
// version, and pnpm-lock.yaml records that same string as the specifier and resolves it to that version. A range lets
// a lockfile refresh move a toolchain package (the tsup that builds the published dist, the test loader) without a
// package.json diff. Run: pnpm exec tsx test/dep-pins.test.ts   (offline)
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, detail = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}${c || !detail ? "" : `\n      ${detail}`}`); };

type Locked = { specifier?: string; version?: string };
type Importer = Record<string, Record<string, Locked>>;
type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const EXACT = /^\d+\.\d+\.\d+$/;
const FIELDS = ["dependencies", "devDependencies"] as const;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The `importers:` block of a pnpm v9 lockfile: { ".": { devDependencies: { name: { specifier, version } } }, ... }. */
export function importers(lockText: string): Record<string, Importer> {
  const out: Record<string, Importer> = {};
  const lines = lockText.split("\n");
  const start = lines.indexOf("importers:");
  if (start < 0) throw new Error("pnpm-lock.yaml has no importers block");
  let imp: Importer | null = null, field: Record<string, Locked> | null = null, entry: Locked | null = null;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith("  ")) break;
    let m: RegExpExecArray | null;
    if ((m = /^  ([^ ].*):(?: \{\})?$/.exec(line))) { imp = out[m[1]!] = {}; field = null; continue; }
    if ((m = /^    (\w+):$/.exec(line)) && imp) { field = imp[m[1]!] = {}; continue; }
    if ((m = /^      '?([^':]+)'?:$/.exec(line)) && field) { entry = field[m[1]!] = {}; continue; }
    if ((m = /^        (specifier|version): (.+)$/.exec(line)) && entry) entry[m[1] as keyof Locked] = m[2]!.replace(/\(.*$/, "");
  }
  return out;
}

/** One line per offence: a range, a lockfile specifier that differs, or a resolved version that differs. */
export function pinOffences(where: string, pkg: Manifest, imp: Importer | undefined): string[] {
  const out: string[] = [];
  for (const field of FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      const locked = imp?.[field]?.[name];
      const at = `${where} ${field}.${name}`;
      if (spec === "workspace:*") {
        if (locked?.specifier !== spec || !locked.version?.startsWith("link:")) out.push(`${at}: the lockfile does not link the workspace package`);
        continue;
      }
      if (!EXACT.test(spec)) out.push(`${at}: "${spec}" is not an exact version`);
      if (locked?.specifier !== spec) out.push(`${at}: the lockfile specifier is "${locked?.specifier}"`);
      if (locked?.version !== spec) out.push(`${at}: the lockfile resolves ${locked?.version}`);
    }
  }
  return out;
}

const lock = importers(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
const manifests: Record<string, Manifest> = {};
for (const where of Object.keys(lock)) manifests[where] = JSON.parse(readFileSync(join(root, where, "package.json"), "utf8"));
const rootPkg = manifests["."]!;

console.log("dependency pins:");
const all = Object.entries(manifests).flatMap(([where, pkg]) => pinOffences(where, pkg, lock[where]));
ok("every importer pins every dependency to the version pnpm-lock.yaml resolves", all.length === 0, all.join("\n      "));
ok("the parser read the root and every workspace package, with each one's dependency names",
  JSON.stringify(Object.keys(lock).sort()) === JSON.stringify([".", ...readdirSync(join(root, "packages")).map((d) => `packages/${d}`)].sort()) &&
  Object.entries(manifests).every(([where, pkg]) => FIELDS.every((f) =>
    JSON.stringify(Object.keys(pkg[f] ?? {}).sort()) === JSON.stringify(Object.keys(lock[where]?.[f] ?? {}).sort()))),
  Object.keys(lock).join(", "));
ok("peer suffixes are stripped from the resolved version", lock["."]?.devDependencies?.tsup?.version === rootPkg.devDependencies?.tsup);

const caret = { ...rootPkg, devDependencies: { ...rootPkg.devDependencies, tsx: `^${rootPkg.devDependencies?.tsx}` } };
ok("a caret range on a dev dependency is an offence", pinOffences(".", caret, lock["."]).some((l) => l.startsWith(". devDependencies.tsx:") && l.includes("not an exact version")));
const stale = structuredClone(lock["."]!);
stale.devDependencies!.typescript!.specifier = "^5.6.0";
ok("a lockfile still carrying the old range as its specifier is an offence", pinOffences(".", rootPkg, stale).includes('. devDependencies.typescript: the lockfile specifier is "^5.6.0"'));
const drift = structuredClone(lock["packages/codec"]!);
drift.dependencies!["@noble/hashes"]!.version = "1.0.0";
ok("a lockfile that resolves another version is an offence", pinOffences("packages/codec", manifests["packages/codec"]!, drift).includes("packages/codec dependencies.@noble/hashes: the lockfile resolves 1.0.0"));
const unlinked = structuredClone(lock["."]!);
unlinked.devDependencies!["@inversealtruism/csd-codec"]!.version = "0.1.18";
ok("a workspace:* dependency the lockfile resolves from the registry is an offence", pinOffences(".", rootPkg, unlinked).includes(". devDependencies.@inversealtruism/csd-codec: the lockfile does not link the workspace package"));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
