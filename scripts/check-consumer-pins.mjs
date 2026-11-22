#!/usr/bin/env node
// Cross-repo pin-coherence guard (shared-core de-dup, cairn docs/Plans/46, audit Batch-3).
//
// cairnx-core is the single source of the CairnX convention; every consumer must pin the SAME published
// version (or carry a vendored bundle of it). The within-csd-sdk check-lockstep.mjs cannot see the sibling
// consumer repos, so this best-effort check asserts they agree. Run from the csd-sdk repo with the sibling
// repos checked out under the same parent (the dev/host layout). Skips any repo that isn't present.
//
//   node scripts/check-consumer-pins.mjs        # exit 1 if a consumer pins a different cairnx-core, or a cairnx-api,
//                                               # cairnx-replica or cairnx-pin published against another peer than it pins
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = join(dirname(fileURLToPath(import.meta.url)), "..");   // this checkout, whatever its directory is called
const ROOT = join(SDK, "..");                                       // its parent, where the sibling consumers live
const canonical = JSON.parse(readFileSync(join(SDK, "packages/cairnx/package.json"), "utf8")).version;

// consumers that pin cairnx-core directly via npm (the bundled consumers, cairn UI and cairn-wallet, carry a
// vendored esbuild instead and are guarded by their own check-vendor-fresh + PROVENANCE, not a pin).
// Tiers (Plans/68 D3): "strict" = any pin mismatch is fatal (a live replayer must not lag at all). "graded" = a lag is fatal ONLY when the pinned-version..canonical diff touches the
// consensus surface (packages/cairnx/src/{resolve,records,types}.ts and the resolve/ handlers, the bytes a
// replayer derives state from); a helpers-only lag (preflight/primary/client-selector logic) is an ADVISORY nudge, because the
// lagging consumer still computes byte-identical canonical state. Grading needs the cairnx-core-<ver> tag
// to compute the diff; an unknown pinned version fails CLOSED (fatal) rather than guessing.
const CONSUMERS = [
  ["cairnx svc", "cairnx/package.json", "strict"],
  ["cairn-sdk", "cairn-sdk/package.json", "graded"],
  ["clarvis", "clarvis/package.json", "graded"], // second-source resolver; usually on its own host, so skipped here
];

const { execSync, execFileSync } = await import("node:child_process");
const CONSENSUS_SURFACE = ["packages/cairnx/src/resolve.ts", "packages/cairnx/src/resolve", "packages/cairnx/src/records.ts", "packages/cairnx/src/types.ts"];
/** "" when ver..HEAD leaves the consensus surface untouched; a --stat summary when it drifted; null when unknowable. */
function consensusDrift(ver) {
  // ver comes from a sibling package.json (trusted), but guard the shape anyway before it reaches a
  // shell tag ref: anything but an exact semver is treated as unknowable (fail-closed to fatal drift).
  if (!/^\d+\.\d+\.\d+$/.test(String(ver))) return null;
  try {
    return execSync(`git -C ${SDK} diff cairnx-core-${ver} HEAD --stat -- ${CONSENSUS_SURFACE.join(" ")}`, { encoding: "utf8" }).trim();
  } catch { return null; }
}

// One copy per consumer: a package with an exact peer on another workspace package (cairnx-api and cairnx-replica on
// cairnx-core, cairnx-pin on cairnx-replica) is packed from `workspace:*` with the peer's version of the commit it was
// released from, which its `<name>-<ver>` tag names (docs/release.md). A consumer that pins such a package, in any
// dependency section, must pin that peer version in its dependencies; any other pin installs a second copy or runs the
// package on a peer it was not built against. A version with no tag, or a tag whose manifest names another version,
// fails closed.
const SCOPE = "@inversealtruism/";
const PEERED = [
  ["cairnx-api", "packages/cairnx-api/package.json", "cairnx-core", "packages/cairnx/package.json", "TWO CORES"],
  ["cairnx-replica", "packages/replica/package.json", "cairnx-core", "packages/cairnx/package.json", "TWO CORES"],
  ["cairnx-pin", "packages/pin/package.json", "cairnx-replica", "packages/replica/package.json", "TWO REPLICAS"],
];
const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
/** The `version` of `path` at the tag, or null. */
const versionAtTag = (tag, path) => {
  try {
    const manifest = execFileSync("git", ["-C", SDK, "show", `${tag}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return String(JSON.parse(manifest).version);
  } catch { return null; }
};
/** The version of the peer at `peerPath` that `pkg`@`ver` was published against, or null when unknowable. */
function peerOf(pkg, path, peerPath, ver) {
  if (!/^\d+\.\d+\.\d+$/.test(String(ver))) return null;
  if (versionAtTag(`${pkg}-${ver}`, path) !== ver) return null;
  return versionAtTag(`${pkg}-${ver}`, peerPath);
}

console.log(`cairnx-core canonical version: ${canonical}`);
let seen = 0, advis = 0;
const failed = new Set();
const fail = (name, msg) => { console.error(msg); failed.add(name); };

/** The core pin against the canonical version, by the consumer's tier. */
function checkCorePin(name, dep, tier) {
  if (dep === canonical) { console.log(`  ✓ ${name} pins cairnx-core ${dep}`); return; }
  if (tier === "graded") {
    const drift = consensusDrift(dep);
    if (drift === "") { console.warn(`  ⚠ ${name} pins cairnx-core ${dep} != canonical ${canonical}: helpers-only lag (consensus surface identical); re-pin when convenient`); advis++; return; }
    if (drift === null) return fail(name, `  ✗ ${name} pins cairnx-core ${dep}: UNKNOWN version (no cairnx-core-${dep} tag to grade against), treat as drift, re-pin`);
    return fail(name, `  ✗ ${name} pins cairnx-core ${dep} != canonical ${canonical}: CONSENSUS-SURFACE DRIFT, a live replayer on it forks:\n${drift.split("\n").map((l) => "      " + l).join("\n")}`);
  }
  fail(name, `  ✗ ${name} pins cairnx-core ${dep} != canonical ${canonical}: re-pin + reinstall + (svc) restart`);
}

/** A consumer that pins `pkg`@`ver`, in `section`, pins in its dependencies the `peer` that version was published against. */
function checkOnePeer(name, manifest, [pkg, path, peer, peerPath, two], ver, section) {
  const dep = manifest.dependencies?.[SCOPE + peer];
  const want = peerOf(pkg, path, peerPath, ver);
  if (want === null) return fail(name, `  ✗ ${name} pins ${pkg} ${ver} (${section}): UNKNOWN version (no ${pkg}-${ver} tag naming that version to read its ${peer} from), re-pin`);
  if (want !== dep) return fail(name, `  ✗ ${name} pins ${peer} ${dep} but ${pkg} ${ver} (${section}) was published against ${peer} ${want}: ${two}, pin ${peer} ${want} or the ${pkg} built on ${dep}`);
  console.log(`  ✓ ${name} pins ${pkg} ${ver} (${section}) on its ${peer} ${want}`);
}

for (const [name, rel, tier] of CONSUMERS) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) { console.log(`  • ${name}: not present, skip`); continue; }
  seen++;
  const manifest = JSON.parse(readFileSync(p, "utf8"));
  const dep = manifest.dependencies?.["@inversealtruism/cairnx-core"];
  checkCorePin(name, dep, tier);
  for (const p of PEERED) for (const section of SECTIONS) if (manifest[section]?.[SCOPE + p[0]] !== undefined) checkOnePeer(name, manifest, p, manifest[section][SCOPE + p[0]], section);
}
if (failed.size) { console.error(`\nconsumer-pin coherence FAILED (${failed.size}/${seen})`); process.exit(1); }
console.log(`\nconsumer-pin coherence OK (${seen} npm-pinning consumers${advis ? `, ${advis} advisory helpers-only lag` : ""}). Bundled consumers (cairn UI, wallet) are guarded by their own vendor-freshness gates.`);
