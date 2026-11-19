// The package as a consumer meets it: its manifest, its version constant, and its public types compiled by tsc from
// outside, importing the package by its name through its exports, under node16 (as ESM and as CommonJS) and bundler
// resolution, with the libraries' own declarations checked too. Run after the build.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { CAIRNX_API_VERSION } from "../src/index.js";
import { done, ok, show } from "./check.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as Record<string, unknown>;

console.log("manifest:");
ok(`CAIRNX_API_VERSION ${CAIRNX_API_VERSION} equals package.json's version`, CAIRNX_API_VERSION === manifest.version);
ok("name, licence, author", manifest.name === "@inversealtruism/cairnx-api" && manifest.license === "MIT" && manifest.author === "InverseAltruism");
const scripts = manifest.scripts as Record<string, string>;
ok("publishable: not private, public access, the repository directory, prepack builds and prepublishOnly is the publish guard",
  manifest.private === undefined && show(manifest.publishConfig) === show({ access: "public" }) &&
  show(manifest.repository) === show({ type: "git", url: "git+https://github.com/InverseAltruism/csd-sdk.git", directory: "packages/cairnx-api" }) &&
  scripts.prepack === "pnpm build" && scripts.prepublishOnly === "node ../../scripts/publish-guard.mjs");
const coreManifest = JSON.parse(readFileSync(join(dirname(createRequire(import.meta.url).resolve("@inversealtruism/cairnx-core")), "..", "package.json"), "utf8")) as { dependencies: Record<string, string> };
ok("cairnx-core is its only peer and dev dependency, as workspace:*; @noble/hashes its one runtime dependency, at cairnx-core's pin",
  isDeepStrictEqual(manifest.peerDependencies, { "@inversealtruism/cairnx-core": "workspace:*" }) &&
  isDeepStrictEqual(manifest.devDependencies, { "@inversealtruism/cairnx-core": "workspace:*" }) &&
  isDeepStrictEqual(manifest.dependencies, { "@noble/hashes": coreManifest.dependencies["@noble/hashes"] }));
ok("files ships dist, LICENSE, README.md and CHANGELOG.md", isDeepStrictEqual(manifest.files, ["dist", "LICENSE", "README.md", "CHANGELOG.md"]));
const entry = (d: string) => ({ import: { types: `./dist/${d}index.d.ts`, default: `./dist/${d}index.js` }, require: { types: `./dist/${d}index.d.cts`, default: `./dist/${d}index.cjs` } });
ok("two entries, `.` and `./handlers`, each with ESM and CommonJS types", show(manifest.exports) === show({ ".": entry(""), "./handlers": entry("handlers/") }));

const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
const compile = (file: string, module: string, resolution: string, trace = false) => spawnSync(process.execPath, [tsc, "--noEmit", "--strict",
  "--noUncheckedIndexedAccess", "--target", "ES2022", "--module", module, "--moduleResolution", resolution, "--skipLibCheck", "false",
  "--types", "node", ...(trace ? ["--traceResolution"] : []), file], { encoding: "utf8" });
const resolvedTo = (out: string, sub = "") => new RegExp(`Module name '@inversealtruism/cairnx-api${sub}' was successfully resolved to '([^']+)'`).exec(out)?.[1] ?? "";

console.log("types, as a consumer compiles them:");
for (const [file, module, resolution, entry] of [
  ["consumer.ts", "node16", "node16", "dist/index.d.ts"],
  ["consumer.cts", "node16", "node16", "dist/index.d.cts"],
  ["consumer.ts", "esnext", "bundler", "dist/index.d.ts"],
] as const) {
  const r = compile(join(pkg, "test/fixtures", file), module, resolution, true);
  const errors = r.stdout.split("\n").filter((l) => /error TS/.test(l));
  const handlers = join(pkg, entry.replace("dist/", "dist/handlers/"));
  ok(`${file} under ${resolution} resolves the package to ${entry}, ./handlers to its handlers/ twin, and compiles clean`,
    r.status === 0 && errors.length === 0 && resolvedTo(r.stdout) === join(pkg, entry) && resolvedTo(r.stdout, "/handlers") === handlers,
    `${resolvedTo(r.stdout)} ${resolvedTo(r.stdout, "/handlers")} ${errors.slice(0, 3).join(" | ")}`);
}
const tmp = mkdtempSync(join(pkg, "test/fixtures/.control-"));
try {
  const control = join(tmp, "subpath.ts");
  writeFileSync(control, 'import { pageOf } from "@inversealtruism/cairnx-api/handlers/page";\nvoid pageOf;\n');
  const r = compile(control, "node16", "node16");
  ok("control: a subpath outside the exports does not compile", r.status !== 0 && /TS2307/.test(r.stdout), r.stdout.slice(0, 200));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

done("cairnx-api package");
