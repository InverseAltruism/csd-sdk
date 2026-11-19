// CAIRNX_CORE_VERSION names the package it ships in: a host hands it to cairnx-api's prepareView (part of `rev`) and a
// replica reports it, so a bump that moves package.json without it fails here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CAIRNX_CORE_VERSION } from "../src/index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
assert.equal(CAIRNX_CORE_VERSION, manifest.version, "CAIRNX_CORE_VERSION equals package.json's version");
const dist = (await import(new URL("../dist/index.js", import.meta.url).href)) as { CAIRNX_CORE_VERSION?: unknown };
assert.equal(dist.CAIRNX_CORE_VERSION, manifest.version, "the built dist exports the same version");
const dts = readFileSync(new URL("../dist/index.d.ts", import.meta.url), "utf8");
assert.ok(dts.includes(`CAIRNX_CORE_VERSION = "${manifest.version}"`), "dist/index.d.ts declares the version literal");
console.log(`cairnx-core version: 3 passed (CAIRNX_CORE_VERSION ${CAIRNX_CORE_VERSION} equals package.json's, in src, dist and the .d.ts)`);
