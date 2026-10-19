// The CI workflow's security shape: the token is read-only, no checkout keeps credentials, every action is pinned to
// a full commit SHA, and the secret scan runs the pinned gitleaks with this repo's config over the full history
// including merge diffs (the default log shows no diff for a merge, so a secret added in a conflict resolution would
// go unscanned). Run: pnpm exec tsx test/ci-workflow.test.ts   (offline)
import { readFileSync } from "node:fs";

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

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
