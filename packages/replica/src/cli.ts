#!/usr/bin/env node
// cairnx-replica check: from an install alone, opens a replica in memory on the one source the caller names, reads it
// until it is caught up, and prints the level, the tuple at the newest final boundary and its comparison with a
// reference. It asks no host the caller did not name. Exit 0 when the tuple equals the reference (or, with none named,
// when a tuple is held), 1 on anything else, 2 on a usage or configuration error.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { HASH_RE } from "@inversealtruism/cairnx-core";
import { ReplicaConfigError, checkPin, hostedBlocks, indexerFeed, local, memoryStore, open, pinned, type OpenOptions, type Pin, type ReplicaStatus, type Tuple } from "./server.js";

export const USAGE = `usage: cairnx-replica check <source> [--pin] [--reference <base> | --expect <tuple>] [--json] [--timeout-ms <ms>]
  <source>, one of:
    --node <url>      one's own node (loopback, a private address or a host in CAIRNX_OWN_NODE_HOSTS)
    --hosted <origin> complete blocks from a front door, headers verified from --anchor <height>:<hash> or the pin
    --feed <base>     a csd-indexer's records (level 1)
  --pin               start from @inversealtruism/cairnx-pin (installed beside this package); not with --feed
  --reference <base>  a host of /cairnx/tuple/<height>[:<blockHash>] to compare with
  --expect <tuple>    <height>:<blockHash>:<eventsHash>:<stateHash> to compare with`;

/** A one-shot read of the whole range: wide steps, since every commit is in memory. */
const STEP = { maxBlocks: 512, maxRequests: 600 } as const;
/** A refusal that the next step answers the same way (README "Pins", "Reading"), so waiting longer changes nothing. */
const STICKY = new Set(["PIN_MISMATCH", "PIN_OFF_CHAIN", "BELOW_FLOOR"]);
const PIN_PACKAGE = "@inversealtruism/cairnx-pin";

export type Result = "equal" | "held" | "branch" | "records" | "rules" | "missing" | "unavailable" | "no-tuple";
export interface CheckIo {
  readonly out: (line: string) => void;
  readonly fetch?: typeof fetch;
  /** The pin's module; default an import of @inversealtruism/cairnx-pin. */
  readonly loadPin?: () => Promise<unknown>;
  readonly sleep?: (ms: number) => Promise<void>;
}

class Usage extends Error {}
const usage = (why: string): never => { throw new Usage(why); };

interface Args { node?: string; hosted?: string; feed?: string; anchor?: string; pin: boolean; reference?: string; expect?: string; want: Tuple | null; json: boolean; timeoutMs: number }
function parse(argv: readonly string[]): Args {
  if (argv[0] !== "check") usage("the one command is check");
  const a: Args = { pin: false, json: false, timeoutMs: 7_200_000, want: null };
  const value = (i: number) => argv[i + 1] ?? usage(`${argv[i]} needs a value`);
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--pin") a.pin = true;
    else if (k === "--json") a.json = true;
    else if (k === "--node" || k === "--hosted" || k === "--feed" || k === "--anchor" || k === "--reference" || k === "--expect") a[k.slice(2) as "node"] = value(i++);
    else if (k === "--timeout-ms") { a.timeoutMs = Number(value(i++)); if (!Number.isSafeInteger(a.timeoutMs) || a.timeoutMs <= 0) usage("--timeout-ms is a positive whole number"); }
    else usage(`unknown argument ${k}`);
  }
  if ([a.node, a.hosted, a.feed].filter((x) => x !== undefined).length !== 1) usage("name one source: --node, --hosted or --feed");
  if (a.feed !== undefined && (a.pin || a.anchor !== undefined)) usage("a feed takes no pin and no anchor: only blocks sit above a pin");
  if (a.hosted !== undefined && a.pin === (a.anchor !== undefined)) usage("--hosted takes --anchor or --pin, one of them");
  if (a.node !== undefined && a.anchor !== undefined) usage("--node is its own header root and takes no anchor");
  if (a.reference !== undefined && a.expect !== undefined) usage("--reference or --expect, not both");
  if (a.expect !== undefined) a.want = expected(a.expect);
  return a;
}

const cursorOf = (s: string, what: string) => {
  const [h, hash, ...rest] = s.split(":");
  const height = Number(h);
  if (rest.length || !Number.isSafeInteger(height) || height < 0 || !HASH_RE.test(hash ?? "")) usage(`${what} is <height>:<0x and 64 lowercase hex>`);
  return { height, hash: hash! };
};
function expected(s: string): Tuple {
  const [h, blockHash, eventsHash, stateHash, ...rest] = s.split(":");
  const height = Number(h);
  if (rest.length || !Number.isSafeInteger(height) || ![blockHash, eventsHash, stateHash].every((x) => HASH_RE.test(x ?? ""))) {
    usage("--expect is <height>:<blockHash>:<eventsHash>:<stateHash>, each hash 0x and 64 lowercase hex");
  }
  return { height, blockHash: blockHash!, eventsHash: eventsHash!, stateHash: stateHash! };
}

async function options(a: Args, io: CheckIo): Promise<OpenOptions> {
  const http = io.fetch === undefined ? {} : { fetch: io.fetch };
  const pin = a.pin ? checkPin(((await (io.loadPin ?? (() => import(PIN_PACKAGE)))()) as { PIN?: unknown }).PIN) : undefined;
  const reference = a.reference === undefined ? {} : { reference: { base: a.reference, ...http } };
  if (a.feed !== undefined) return { source: indexerFeed({ indexerUrl: a.feed, ...http }), store: memoryStore(), step: STEP, ...reference };
  if (a.node !== undefined) return { ...local({ node: a.node, ...http, ...(pin === undefined ? {} : { pin }) }), step: STEP, ...reference };
  const anchor = pin === undefined ? cursorOf(a.anchor!, "--anchor") : { height: pin.height, hash: pin.blockHash };
  const blocks = hostedBlocks({ origin: a.hosted!, root: { kind: "anchor", anchor }, ...http });
  return { source: pin === undefined ? blocks : pinned({ pin: pin as Pin, then: blocks }), store: memoryStore(), step: STEP, ...reference };
}

/** How `ours` stands to `want`, in the kinds of a reference's CompareReport. */
function against(ours: Tuple, want: Tuple): Result {
  if (ours.height !== want.height) return "missing";
  if (ours.blockHash !== want.blockHash) return "branch";
  if (ours.eventsHash !== want.eventsHash) return "records";
  return ours.stateHash === want.stateHash ? "equal" : "rules";
}

/** Advances until the cursor reaches the tip, a sticky refusal, or the deadline; waits while a step makes no progress. */
async function readOn(advance: () => Promise<ReplicaStatus>, timeoutMs: number, sleep: (ms: number) => Promise<void>): Promise<ReplicaStatus> {
  const end = Date.now() + timeoutMs;
  let s = await advance(), wait = 500, last = s.cursor?.height ?? null;
  while (!(s.cursor !== null && s.at !== null && s.cursor.height >= s.at.tipHeight) && !STICKY.has(s.lastError?.code ?? "") && Date.now() < end) {
    if ((s.cursor?.height ?? null) === last) { await sleep(Math.min(wait, Math.max(0, end - Date.now()))); wait = Math.min(wait * 2, 30_000); }
    else wait = 500;
    last = s.cursor?.height ?? null;
    s = await advance();
  }
  return s;
}

/** The command: prints its report through `io.out` and returns the exit code. */
export async function runCheck(argv: readonly string[], io: CheckIo): Promise<number> {
  let a: Args;
  let o: OpenOptions;
  try { a = parse(argv); o = await options(a, io); } catch (e) {
    if (e instanceof Usage || e instanceof ReplicaConfigError) { io.out(`cairnx-replica: ${e.message}`); if (e instanceof Usage) io.out(USAGE); return 2; }
    throw e;
  }
  let replica;
  try { replica = await open(o); } catch (e) {
    if (e instanceof ReplicaConfigError) { io.out(`cairnx-replica: ${e.message}`); return 2; }
    throw e;
  }
  try {
    const s = await readOn(() => replica.advance(), a.timeoutMs, io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))));
    const want = a.want;
    const result: Result = s.tuple === null ? "no-tuple" : want !== null ? against(s.tuple, want)
      : a.reference !== undefined ? (s.compare?.kind ?? "unavailable") : "held";
    const report = {
      source: s.source, level: s.level, proof: s.proof, verified: s.verified, why: s.why.map((w) => w.code), notes: s.notes.map((n) => n.code),
      cursor: s.cursor, tipHeight: s.at?.tipHeight ?? null, lastError: s.lastError === null ? null : { code: s.lastError.code, reason: s.lastError.reason },
      tuple: s.tuple, expected: want, compare: s.compare, result,
    };
    if (a.json) io.out(JSON.stringify(report));
    else {
      io.out(`source ${report.source}: level ${report.level}, proof ${report.proof}, ${report.verified ? "verified" : `not verified (${report.why.join(", ")})`}`);
      io.out(`cursor ${report.cursor === null ? "none" : `${report.cursor.height} ${report.cursor.hash}`}, tip ${report.tipHeight ?? "unknown"}${report.lastError === null ? "" : `, last error ${report.lastError.code}: ${report.lastError.reason}`}`);
      io.out(s.tuple === null ? "tuple: no final boundary held" : `tuple ${s.tuple.height} block ${s.tuple.blockHash} events ${s.tuple.eventsHash} state ${s.tuple.stateHash}`);
      if (want !== null || a.reference !== undefined) io.out(`against ${want !== null ? "the expected tuple" : a.reference}: ${result}${s.compare?.detail ? ` (${s.compare.detail})` : ""}`);
      io.out(`result: ${result}`);
    }
    return result === "equal" || result === "held" ? 0 : 1;
  } finally {
    await replica.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await runCheck(process.argv.slice(2), { out: (l) => console.log(l) });
}
