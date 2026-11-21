// The CI workflow's security shape: the token is read-only, no checkout keeps credentials, every action is pinned to
// a full commit SHA, and the secret scan runs the pinned gitleaks with this repo's config over the full history
// including merge diffs (the default log shows no diff for a merge, so a secret added in a conflict resolution would
// go unscanned). Run: pnpm exec tsx test/ci-workflow.test.ts   (offline)
import { existsSync, readdirSync, readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, detail = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}${c || !detail ? "" : `\n      ${detail}`}`); };

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const lines = ci.split("\n");
const GITLEAKS_SHA256 = "ba6dbb656933921c775ee5a2d1c13a91046e7952e9d919f9bac4cec61d628e7d"; // 8.18.4 linux_x64, from the release's checksums file

/** The lines of the step that starts at `i`, up to the next step or job. */
const stepAt = (i: number) => {
  const indent = lines[i]!.indexOf("-");
  const end = lines.findIndex((l, j) => j > i && l.trim() !== "" && l.search(/\S/) <= indent);
  return lines.slice(i, end < 0 ? undefined : end).join("\n");
};

console.log("ci workflow:");
ok("the workflow token is read-only", /^permissions:\n  contents: read\n/m.test(ci) && !/:\s*write\b/.test(ci));
const checkouts = lines.flatMap((l, i) => (/uses: actions\/checkout@/.test(l) ? [i] : []));
const leaky = checkouts.filter((i) => !/persist-credentials: false/.test(stepAt(i)));
ok("every checkout sets persist-credentials: false", checkouts.length === 3 && leaky.length === 0,
  `${checkouts.length} checkouts; without it at line(s) ${leaky.map((i) => i + 1).join(", ")}`);
const uses = [...ci.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
const unpinned = uses.filter((u) => !/@[0-9a-f]{40}$/.test(u));
ok("every action is pinned to a full commit SHA", uses.length > 0 && unpinned.length === 0, unpinned.join(", "));
ok("the secret scan: pinned gitleaks, this repo's config, full history, merge diffs",
  ci.includes("releases/download/v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz") && ci.includes(GITLEAKS_SHA256) &&
  /fetch-depth: 0/.test(ci) && /gitleaks" detect [^\n]*-c \.gitleaks\.toml/.test(ci) &&
  /--log-opts="[^"]*--full-history[^"]*--all[^"]*--diff-merges=first-parent[^"]*"/.test(ci));

// A live suite with no node exits 0 having asserted nothing, so a CI step that runs one reads green while checking
// nothing. They run only from `pnpm test:live`.
const LIVE_ONLY = ["test/oracle.test.ts", "packages/client/test/client.test.ts", "packages/light/test/light.test.ts", "packages/replica/test/node-blocks.live.ts"];
const scripts = (f: string): Record<string, string> => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).scripts;
const root = scripts("package.json");
const pkgOf = (f: string) => f.startsWith("packages/") ? `${f.split("/").slice(0, 2).join("/")}/package.json` : "package.json";
const local = (f: string) => f.startsWith("packages/") ? f.split("/").slice(2).join("/") : f;
ok("CI runs the live opt-in guard (live suites skip by name with CSD_RPC unset, fail when it names no node)",
  /^\s*- run: pnpm exec tsx test\/live-opt-in\.test\.ts\b/m.test(ci));
const inCi = LIVE_ONLY.filter((f) => ci.includes(local(f).replace(/^test\//, "")));
ok("no CI step runs a live-only suite", inCi.length === 0, inCi.join(", "));
const offline = LIVE_ONLY.filter((f) => {
  const s = scripts(pkgOf(f));
  return Object.entries(s).some(([k, v]) => k !== "test:live" && v.includes(local(f)));
});
ok("no offline script runs a live-only suite", offline.length === 0, offline.join(", "));
const reached = LIVE_ONLY.filter((f) => (scripts(pkgOf(f))["test:live"] ?? "").includes(local(f)));
ok("every live-only suite runs from test:live, and the root test:live reaches the packages",
  reached.length === LIVE_ONLY.length && /--if-present run test:live/.test(root["test:live"] ?? ""), `reached: ${reached.join(", ")}`);

// The block scripts read a node (the differential also the indexer) over a whole height range: maintainer tools,
// run by hand, in no CI step and no package script.
const LIVE_SCRIPTS = ["capture-events-fixture.mjs", "events-live-differential.mjs", "scan-repeated-txids.mjs"];
const manifests = ["package.json", ...readdirSync(new URL("../packages", import.meta.url)).map((p) => `packages/${p}/package.json`)];
const runners = [ci, ...manifests.map((f) => Object.values(scripts(f)).join("\n"))];
const runAnywhere = LIVE_SCRIPTS.filter((s) => runners.some((text) => text.includes(s)));
ok(`no CI step and no package script runs a live block script (${manifests.length} manifests)`,
  manifests.length >= 9 && runAnywhere.length === 0 && LIVE_SCRIPTS.every((s) => existsSync(new URL(`../conformance/${s}`, import.meta.url))),
  runAnywhere.join(", "));
// The pin generator reads a node over the whole range above the last pin: run by hand, like the block scripts. Its
// package test loads its functions against a recorded node, never the script.
ok("no CI step and no package script runs the pin generator", existsSync(new URL("../packages/pin/scripts/generate-pin.mjs", import.meta.url)) &&
  runners.every((text) => !text.includes("generate-pin.mjs")));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
