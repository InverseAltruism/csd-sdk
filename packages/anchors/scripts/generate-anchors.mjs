#!/usr/bin/env node
// The anchors generator, run by hand on the deploy host, in no CI step and no package script (its `--check` runs
// from .github/workflows/anchors-check.yml, started by hand):
//   node generate-anchors.mjs <anchor.json> [--headers <base>, else ANCHORS_HEADERS_BASE] [--write]
//   node generate-anchors.mjs --check --headers <base> --rpc <base>
// <anchor.json> is the line cairn's bump-swapguard-cp.mjs --emit-json --target <height> prints: three sources (node,
// miner, third), each of which must answer "yes". Generate walks the served headers from the committed table's own
// floor through csd-light (hash, prev link, time rules, LWMA bits, PoW), so every entry is the hash the walk reaches
// at its height, not a served one. It writes anchors.json only when every check passes, the walk reaches the
// corroborated hash and the new table extends the committed one entry for entry. The floor is carried from the
// committed table, not derived from served data. --check re-walks the committed table from <headers> and requires the
// floor, the activation root and every entry canonical at <rpc>, and the newest entry at least MIN_MARGIN below
// <rpc>'s tip. Read-only GETs, no redirect followed, paced.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LightClient } from "@inversealtruism/csd-light";
import { CHUNK, HASH_RE, TABLE, extensionFault, firstChunk, parseTable, renderJson, topOf } from "./table.mjs";

export const PAGE = 512;
export const MIN_MARGIN = 1000;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parses and checks the cairn C1 JSON line; returns { height, hash, tip } or throws naming the failed rule. */
export function validateC1(text, chunk, floor) {
  let j;
  try { j = JSON.parse(String(text).trim()); } catch { throw new Error("anchor JSON is empty or not JSON (bump-swapguard-cp refused?)"); }
  const src = Array.isArray(j?.sources) ? j.sources : [];
  const role = (r) => src.find((s) => s?.role === r);
  const rules = [
    ["v must be 1", j?.v === 1],
    ["exactly three sources: node, miner, third", src.length === 3 && ["node", "miner", "third"].every((r) => src.filter((s) => s?.role === r).length === 1)],
    ["every source must answer yes", src.length === 3 && src.every((s) => s?.answer === "yes")],
    ["the third source must be routed to its primary backend", role("third")?.routing === "primary"],
    [`margin must be at least ${MIN_MARGIN}`, Number.isSafeInteger(j?.margin) && j.margin >= MIN_MARGIN],
    [`height must be at least ${MIN_MARGIN} below tip`, Number.isSafeInteger(j?.height) && Number.isSafeInteger(j?.tip) && j.height <= j.tip - MIN_MARGIN],
    ["hash must be 0x and 64 lowercase hex", typeof j?.hash === "string" && HASH_RE.test(j.hash)],
    [`height must be a chunk top (${chunk}k + ${chunk - 1})`, j?.height % chunk === chunk - 1],
    ["height must be at or above the first chunk top", j?.height >= topOf(firstChunk(floor.height, chunk), chunk)],
  ];
  const bad = rules.find(([, ok]) => !ok);
  if (bad) throw new Error(`anchor JSON refused: ${bad[0]}`);
  return { height: j.height, hash: j.hash, tip: j.tip };
}

// Retry-After-paced JSON GET. A 3xx is an error: a source must not answer from another host.
export async function getJson(url, { fetch = globalThis.fetch, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if ((r.status === 429 || r.status === 502 || r.status === 503) && attempt < 8) {
      const ra = Number(r.headers.get("retry-after"));
      await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * (attempt + 1), 120_000));
      continue;
    }
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.json();
  }
}

/** One page-aligned /api/headers range, exactly `pageSize` rows at consecutive heights, or a throw. */
export async function fetchPage(base, from, pageSize, io) {
  const d = await getJson(`${base}/api/headers/${from}/${pageSize}`, io);
  const rows = d?.headers;
  if (!Array.isArray(rows) || rows.length !== pageSize) throw new Error(`/api/headers/${from}/${pageSize}: ${Array.isArray(rows) ? rows.length : "no"} rows, want ${pageSize}`);
  rows.forEach((row, i) => {
    if (row?.height !== from + i || typeof row.hash !== "string" || !row.header) throw new Error(`/api/headers/${from}/${pageSize}: row ${i} is not height ${from + i}`);
  });
  return rows;
}

/** Walks from the floor pin to max(tops); returns the walked hash at each top. */
export async function walkTops({ floor, tops, base, pageSize = PAGE, paceMs = 550, io = {} }) {
  const sleep = io.sleep ?? defaultSleep;
  const pages = new Map();
  const row = async (h) => {
    const p = h - (h % pageSize);
    if (!pages.has(p)) {
      if (pages.size) await sleep(paceMs);
      pages.set(p, await fetchPage(base, p, pageSize, io));
    }
    return pages.get(p)[h - p];
  };
  const batch = async (from, count) => {
    const out = [];
    for (let h = from; h < from + count; h++) { const r = await row(h); out.push({ header: r.header, hash: r.hash }); }
    return out;
  };
  const lc = new LightClient({ headersBatchProvider: batch, checkpoints: { [floor.height]: floor.hash } });
  await lc.syncFromCheckpoint(floor.height, floor.hash);
  await lc.sync(Math.max(...tops));
  return tops.map((h) => String(lc.chain[h - lc.baseHeight].hash).toLowerCase());
}

/** Generate mode: the new table, written to `tablePath` only with write=true and only after every check. */
export async function generate({ c1Text, tablePath = TABLE, base, write = false, chunk = CHUNK, pageSize = PAGE, paceMs, io }) {
  const old = parseTable(readFileSync(tablePath, "utf8"), chunk);
  const target = validateC1(c1Text, chunk, old.floor);
  const tops = [];
  for (let k = firstChunk(old.floor.height, chunk); topOf(k, chunk) <= target.height; k++) tops.push(topOf(k, chunk));
  const hashes = await walkTops({ floor: old.floor, tops, base, pageSize, paceMs, io });
  if (hashes.at(-1) !== target.hash) throw new Error(`the walk from the floor pin reaches ${hashes.at(-1)} at ${target.height}, not the corroborated ${target.hash}; nothing written`);
  const table = { ...old, anchors: tops.map((height, i) => ({ height, hash: hashes[i] })) };
  const fault = extensionFault(old, table);
  if (fault) throw new Error(`${fault}; nothing written`);
  const text = renderJson(table);
  if (write) writeFileSync(tablePath, text);
  return { table, text, entries: tops.length, newest: target.height };
}

// Tri-state on purpose: "says another hash" and "does not answer" are different facts; the check needs "yes".
export async function canonicalAt(rpc, height, hash, io) {
  let d;
  try { d = await getJson(`${rpc}/block/height/${height}`, io); } catch { return "unreachable"; }
  if (d?.ok !== true || typeof d.hash !== "string") return "unreachable";
  return d.height === height && String(d.hash).toLowerCase() === hash ? "yes" : "no";
}

/** Check mode: every entry equals the walk from `headers`; the floor, the activation root and every entry are canonical at `rpc`. */
export async function check({ tablePath = TABLE, headers, rpc, chunk = CHUNK, pageSize = PAGE, paceMs = 550, io = {} }) {
  const t = parseTable(readFileSync(tablePath, "utf8"), chunk);
  const tops = t.anchors.map((a) => a.height);
  const walked = await walkTops({ floor: t.floor, tops, base: headers, pageSize, paceMs, io });
  const bad = walked.findIndex((h, i) => h !== t.anchors[i].hash);
  if (bad >= 0) throw new Error(`entry ${bad} (height ${tops[bad]}) is ${t.anchors[bad].hash}, the walk from ${headers} reaches ${walked[bad]}`);
  const named = [["the floor", t.floor], ["the activation root", t.activationRoot], ...t.anchors.map((a, i) => [`entry ${i}`, a])];
  for (const [name, a] of named) {
    await (io.sleep ?? defaultSleep)(paceMs);
    const answer = await canonicalAt(rpc, a.height, a.hash, io);
    if (answer !== "yes") throw new Error(`${rpc} answers "${answer}" for ${name} at height ${a.height}`);
  }
  const tip = Number((await getJson(`${rpc}/tip`, io))?.height);
  if (!Number.isSafeInteger(tip)) throw new Error(`${rpc} gave no tip height`);
  const newest = tops.at(-1);
  if (newest > tip - MIN_MARGIN) throw new Error(`newest entry ${newest} is less than ${MIN_MARGIN} below the tip ${tip} at ${rpc}: too shallow to pin`);
  return { entries: tops.length, newest, tip };
}

/** The command line, or a throw naming what is wrong with it. A source's base is a URL with no default host. */
export function parseArgs(argv, env) {
  const o = { check: false, write: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check" || a === "--write") o[a.slice(2)] = true;
    else if ((a === "--headers" || a === "--rpc") && argv[i + 1] !== undefined) o[a.slice(2)] = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown or incomplete option ${a}`);
    else positional.push(a);
  }
  if (!o.check) o.headers ??= env.ANCHORS_HEADERS_BASE;
  const base = (name) => {
    if (!/^https?:\/\/[^\s/]+/.test(o[name] ?? "")) throw new Error(`no ${name} source named: an http(s) base URL is needed, there is no default host`);
    o[name] = o[name].replace(/\/+$/, "");
  };
  base("headers");
  if (o.check) {
    base("rpc");
    if (positional.length > 0 || o.write) throw new Error("--check takes only --headers and --rpc");
  } else if (positional.length !== 1 || o.rpc !== undefined) {
    throw new Error("generate takes one <anchor.json>, --headers and --write");
  }
  return { ...o, c1Path: positional[0] };
}

/** Runs the command line; returns the exit code. `ctx` replaces the table, the grid and the I/O for a test. */
export async function main(argv, env = process.env, ctx = {}) {
  const { log = console.log, err = console.error, tablePath = TABLE, chunk = CHUNK, pageSize = PAGE, paceMs, io } = ctx;
  let a;
  try { a = parseArgs(argv, env); } catch (e) { err(`generate-anchors: ${e instanceof Error ? e.message : String(e)}; nothing read or written`); return 2; }
  try {
    if (a.check) {
      const r = await check({ tablePath, headers: a.headers, rpc: a.rpc, chunk, pageSize, paceMs, io });
      log(`anchors check passed: ${r.entries} entries, newest ${r.newest}, tip ${r.tip} at the second RPC`);
    } else {
      const r = await generate({ c1Text: readFileSync(a.c1Path, "utf8"), tablePath, base: a.headers, write: a.write, chunk, pageSize, paceMs, io });
      log(`${a.write ? "wrote" : "would write (run with --write)"} ${tablePath}: ${r.entries} entries, newest ${r.newest}${a.write ? "; run pnpm build to refresh dist" : ""}`);
    }
    return 0;
  } catch (e) {
    err(`generate-anchors: FAIL: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
