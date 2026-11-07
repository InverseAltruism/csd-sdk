// Every job of every workflow names a fixed runner image, as the other Cairn repos do. GitHub moved ubuntu-latest to
// 26.04, where playwright-core 1.60.0 cannot install its Chromium (cairn-wallet's CI, 2026-11-07); a moving image
// changes the toolchain under a job without a commit.
// RED-FIRST: the last check runs the rule on a copy with one job moved back to ubuntu-latest and expects it to fail.
// Run: pnpm exec tsx test/ci-runner-image.test.ts   (offline)
import { readdirSync, readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, detail = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}${c || !detail ? "" : `\n      ${detail}`}`); };

const dir = new URL("../.github/workflows/", import.meta.url);
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
const text = (f: string) => readFileSync(new URL(f, dir), "utf8");
const images = (t: string) => [...t.matchAll(/^[ \t]*runs-on:[ \t]*(\S*)/gm)].map((m) => m[1]!);
const fixed = (t: string) => images(t).every((img) => img !== "" && !/latest/.test(img));

console.log("ci runner image:");
ok("the workflows under .github/workflows are exactly ci.yml", files.join(",") === "ci.yml", files.join(","));
const ci = text("ci.yml");
ok("ci.yml has its three jobs' runners", images(ci).length === 3, `${images(ci).length} runs-on lines`);
ok("every ci.yml job names a fixed image", fixed(ci), images(ci).join(", "));
const mutated = ci.replace(/^( {4}runs-on: *)\S+/m, "$1ubuntu-latest");
ok("the rule refuses a job on ubuntu-latest", mutated !== ci && !fixed(mutated));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
