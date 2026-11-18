// scripts/check-consensus-citations.mjs on a throwaway tree (the ledger, gate files, one source file) and on this repo.
// Run: pnpm exec tsx test/check-consensus-citations.test.ts   (offline)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCitations, GATE_TEMPLATE } from "../scripts/check-consensus-citations.mjs";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, detail = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}${c || !detail ? "" : `\n      ${detail}`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

console.log("check-consensus-citations:");
const here = checkCitations(root);
ok("this repo is clean", here.failures.length === 0 && here.checked.length > 0, here.failures.join("\n      "));
ok("this repo's gate template is among the documents checked", here.docs.includes(GATE_TEMPLATE), here.docs.join(", "));

const dir = mkdtempSync(join(tmpdir(), "csdsdk-cites-"));
try {
  const put = (f: string, text: string) => {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  };
  put("packages/x/src/rule.ts", "// header\nexport const GATE_HEIGHT_X = 100_000;\nexport const other = 1;\n");
  const ledger = (links: string) => `# Ledger\n\nThe height is \`GATE_HEIGHT_X = 100_000\` at packages/x/src/rule.ts:2.\n\n${links}\n`;
  const gate = (line: number) => `# vX\n\nThe constant \`GATE_HEIGHT_X = 100_000\` is at packages/x/src/rule.ts:${line}.\n`;
  const run = () => checkCitations(dir);

  put("CONSENSUS_CHANGES.md", ledger("Gate file: docs/gates/vx.md."));
  put("docs/gates/vx.md", gate(2));
  put(GATE_TEMPLATE, "# Gate template\n\n```\nan example cite packages/x/src/rule.ts:99\n```\n");
  let r = run();
  ok("a linked gate file with a current citation passes", r.failures.length === 0, r.failures.join("\n      "));
  ok("the gate file's citation is checked, not skipped", r.checked.some((c) => c.endsWith("(docs/gates/vx.md)")), r.checked.join("; "));
  ok("the ledger's own citation is still checked", r.checked.some((c) => c.endsWith("(CONSENSUS_CHANGES.md)")), r.checked.join("; "));
  ok("an unlinked template with a fenced example is not a failure", !r.failures.some((f) => f.includes("TEMPLATE")));

  put("docs/gates/vx.md", gate(3));
  r = run();
  ok("a stale line in a gate file fails and names the gate file",
    r.failures.some((f) => f.startsWith("docs/gates/vx.md:3 cites packages/x/src/rule.ts:3 with no content anchor")), r.failures.join("\n      "));

  put("docs/gates/vx.md", "# vX\n\nAs shipped at packages/x/src/rule.ts:2:\n\n    export const GATE_HEIGHT_X = 100_001;\n");
  r = run();
  ok("a quotation in a gate file is checked verbatim",
    r.failures.some((f) => f.startsWith("docs/gates/vx.md:3 quotes packages/x/src/rule.ts:2 verbatim")), r.failures.join("\n      "));

  put("docs/gates/vx.md", gate(2));
  put("docs/gates/vy.md", gate(2));
  r = run();
  ok("a gate file the ledger does not link fails", r.failures.includes("docs/gates/vy.md is not linked from CONSENSUS_CHANGES.md"), r.failures.join("\n      "));
  rmSync(join(dir, "docs/gates/vy.md"));

  put("CONSENSUS_CHANGES.md", ledger("Gate files: docs/gates/vx.md, docs/gates/vz.md."));
  r = run();
  ok("a linked gate file that does not exist fails", r.failures.includes("CONSENSUS_CHANGES.md links docs/gates/vz.md, which does not exist"), r.failures.join("\n      "));

  rmSync(join(dir, "docs"), { recursive: true });
  put("CONSENSUS_CHANGES.md", ledger(""));
  r = run();
  ok("a tree without docs/gates checks the ledger alone", r.failures.length === 0 && r.docs.length === 1 && r.checked.length === 1, JSON.stringify(r));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
