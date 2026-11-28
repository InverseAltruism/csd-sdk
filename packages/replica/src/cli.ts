#!/usr/bin/env node
// cairnx-replica check: from an install alone, opens a replica in memory on the one source the caller names, reads it
// until it is caught up, and prints the level, the tuple at the newest final boundary and its comparison with a
// reference. It asks no host the caller did not name. The exit codes are EXIT_OF's, frozen with 0.1.0.
// cairnx-replica serve: the open server (open-server.ts) over one's own node and a replica of it kept on disk.
import { realpathSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HASH_RE } from "@inversealtruism/cairnx-core";
import { serverBase } from "./node-address.js";
import { PIN_REFUSALS } from "./pinned.js";
import { OPEN_HOST, OPEN_PORT, READ_ADVANCE_MS, ReplicaConfigError, checkPin, hostedBlocks, indexerFeed, listen, local, memoryStore, open, openServer, ownNode, pinned, replicaReads,
  type OpenOptions, type Pin, type ReplicaStatus, type Tuple } from "./server.js";

export const USAGE = `usage: cairnx-replica check <source> [--pin] [--reference <base> | --expect <tuple>] [--json] [--timeout-ms <ms>]
  <source>, one of:
    --node <url>      one's own node (loopback, a private address or a host in CAIRNX_OWN_NODE_HOSTS)
    --hosted <origin> complete blocks from a front door, headers verified from --anchor <height>:<hash> or the pin
    --feed <base>     a csd-indexer's records (level 1); a first sync is thousands of requests, so one's own
                      indexer or a host without a request limit (against https://cairn-substrate.com use --hosted --pin)
  --pin               start from @inversealtruism/cairnx-pin (installed beside this package); not with --feed
  --reference <base>  a host of /cairnx/tuple/<height>[:<blockHash>] to compare with
  --expect <tuple>    <height>:<blockHash>:<eventsHash>:<stateHash> to compare with
  --timeout-ms <ms>   the deadline, 1 to 2147483647 (default 7200000)
exit: 0 the check passed (equal, held); 1 the sides differ (branch, records, rules); 2 usage or configuration;
      3 could not check (missing, unavailable, no-tuple, timeout)`;
export const SERVE_USAGE = `usage: cairnx-replica serve --node <url> --dir <path> [--listen <address>] [--port <port>]
  --node <url>        one's own node (loopback, a private address or a host in CAIRNX_OWN_NODE_HOSTS)
  --dir <path>        the replica's store directory, created when missing
  --listen <address>  the address to bind (default ${OPEN_HOST}); any other, 0.0.0.0 among them, is a public bind
  --port <port>       1 to 65535 (default ${OPEN_PORT}), 0 for a free one
exit: 0 stopped by SIGINT or SIGTERM; 2 usage or configuration, or the address could not be bound`;

/** A one-shot read of the whole range: wide steps, since every commit is in memory. */
const STEP = { maxBlocks: 512, maxRequests: 600 } as const;
/** A refusal that the next step answers the same way (a pinned source keeps its refusal, pinned.ts; an anchor above
 *  the floor stays there), so waiting longer changes nothing. */
const STICKY = new Set<string>([...PIN_REFUSALS, "BELOW_FLOOR"]);
const PIN_PACKAGE = "@inversealtruism/cairnx-pin";
/** How long, after the deadline, the command waits for the source to stop before it exits without it. Every source,
 *  a feed's scan included, ends its step with the deadline's signal; this is the backstop for a request that does not
 *  settle on its abort. */
export const CLOSE_GRACE_MS = 5_000;
/** The longest text from a source, a reference or an error made from their bytes that a line shows, in UTF-16 units. */
export const SHOWN_MAX = 400;

export type Result = "equal" | "held" | "branch" | "records" | "rules" | "missing" | "unavailable" | "no-tuple" | "timeout";
/** The exit code of each result, frozen with 0.1.0 (README "Checking an installation"): 0 the check passed; 1 it ran
 *  and the two sides differ; 3 it could not check, including `missing`, where the other side holds no tuple at that
 *  boundary (a reference keeps a bounded window; an expected tuple at another height than the newest held), which
 *  contradicts nothing. 2 is a usage or configuration error. */
export const EXIT_OF: Readonly<Record<Result, 0 | 1 | 3>> = Object.freeze({
  equal: 0, held: 0, branch: 1, records: 1, rules: 1, missing: 3, unavailable: 3, "no-tuple": 3, timeout: 3,
});
/** The result a sticky refusal of a pinned source gives: a gate table or a chain that differs from the pin's. */
const REFUSED: Readonly<Record<string, Result>> = Object.freeze({ RULES_DIFFER: "rules", PIN_OFF_CHAIN: "branch" });

// Control, DEL, C1, and the bidi and line separator characters: shown as \uXXXX, so no text a source chose moves the
// cursor, retitles the terminal or reorders what is shown.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
/** The one print boundary: every line the command writes, to stdout or stderr, plain or --json, passes through it. In
 *  JSON text these characters occur only inside strings, where the escape is valid JSON. */
export const printable = (line: string): string => line.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** Text from a source, a reference or an error made from their bytes, cut to SHOWN_MAX. */
const clip = (t: string): string => (t.length > SHOWN_MAX ? `${t.slice(0, SHOWN_MAX)} [${t.length - SHOWN_MAX} more characters cut]` : t);
export interface CheckIo {
  readonly out: (line: string) => void;
  /** Progress, each source error and the deadline, one line each; default stderr, so --json keeps stdout to the report. */
  readonly err?: (line: string) => void;
  readonly fetch?: typeof fetch;
  /** The pin's module; default an import of @inversealtruism/cairnx-pin. */
  readonly loadPin?: () => Promise<unknown>;
  readonly sleep?: (ms: number) => Promise<void>;
}

class Usage extends Error { constructor(why: string, readonly text = USAGE) { super(why); } }
const usage = (why: string, text = USAGE): never => { throw new Usage(why, text); };

interface Args { node?: string; hosted?: string; feed?: string; anchor?: string; pin: boolean; reference?: string; expect?: string; want: Tuple | null; json: boolean; timeoutMs: number }
/** setTimeout's largest delay; a larger one fires at once. */
const TIMEOUT_MAX = 2_147_483_647;
/** A height in its one decimal spelling: no sign, no leading zero, no exponent, no space. */
const heightOf = (h: string | undefined): number | null => (h !== undefined && /^(0|[1-9][0-9]{0,15})$/.test(h) && Number.isSafeInteger(Number(h)) ? Number(h) : null);
function parse(argv: readonly string[]): Args {
  if (argv[0] !== "check") usage("the commands are check and serve", `${USAGE}\n${SERVE_USAGE}`);
  const a: Args = { pin: false, json: false, timeoutMs: 7_200_000, want: null };
  const seen = new Set<string>();
  const value = (i: number) => argv[i + 1] ?? usage(`${argv[i]} needs a value`);
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i]!;
    if (k.startsWith("--") && seen.has(k)) usage(`${k} is given twice: give it once`);
    seen.add(k);
    if (k === "--pin") a.pin = true;
    else if (k === "--json") a.json = true;
    else if (k === "--node" || k === "--hosted" || k === "--feed" || k === "--anchor" || k === "--reference" || k === "--expect") a[k.slice(2) as "node"] = value(i++);
    else if (k === "--timeout-ms") {
      const t = heightOf(value(i++));
      if (t === null || t < 1 || t > TIMEOUT_MAX) usage(`--timeout-ms is a whole number from 1 to ${TIMEOUT_MAX}`);
      a.timeoutMs = t!;
    } else usage(`unknown argument ${k}`);
  }
  for (const k of ["feed", "reference"] as const) {
    const u = a[k];
    if (u === undefined) continue;
    try { serverBase(u, `--${k}`); } catch { usage(`--${k} is an http or https URL without credentials, query or fragment`); }
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
  const height = heightOf(h);
  if (rest.length || height === null || !HASH_RE.test(hash ?? "")) usage(`${what} is <height>:<0x and 64 lowercase hex>, the height a whole number in decimal`);
  return { height: height!, hash: hash! };
};
function expected(s: string): Tuple {
  const [h, blockHash, eventsHash, stateHash, ...rest] = s.split(":");
  const height = heightOf(h);
  if (rest.length || height === null || ![blockHash, eventsHash, stateHash].every((x) => HASH_RE.test(x ?? ""))) {
    usage("--expect is <height>:<blockHash>:<eventsHash>:<stateHash>, the height a whole number in decimal, each hash 0x and 64 lowercase hex");
  }
  return { height: height!, blockHash: blockHash!, eventsHash: eventsHash!, stateHash: stateHash! };
}
/** The pin's module, or a configuration error naming the package when it is not installed. */
async function pinModule(io: CheckIo): Promise<unknown> {
  try { return await (io.loadPin ?? (() => import(PIN_PACKAGE)))(); } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "ERR_MODULE_NOT_FOUND" && String((e as Error).message).includes(PIN_PACKAGE)) {
      throw new ReplicaConfigError(`--pin needs ${PIN_PACKAGE}: install ${PIN_PACKAGE} beside this package`);
    }
    throw e;
  }
}

async function options(a: Args, io: CheckIo): Promise<OpenOptions> {
  const http = io.fetch === undefined ? {} : { fetch: io.fetch };
  const pin = a.pin ? checkPin(((await pinModule(io)) as { PIN?: unknown }).PIN) : undefined;
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

/** How often a sync that has not changed prints its progress line again. */
const PROGRESS_MS = 30_000;
// The tip a step reports is a header its root vouches for, under an anchor root the window's highest, not the server's:
// a step refused part way leaves the cursor at that tip. So the run is caught up only when its last step settled.
const caughtUp = (s: ReplicaStatus) => s.lastError === null && s.cursor !== null && s.at !== null && s.cursor.height >= s.at.tipHeight;
const progressOf = (s: ReplicaStatus) =>
  `syncing: cursor ${s.cursor?.height ?? "none"} of tip ${s.at?.tipHeight ?? "unknown"}, level ${s.level}, proof ${s.proof}, why ${s.why.map((w) => w.code).join(",") || "none"}, notes ${s.notes.map((n) => n.code).join(",") || "none"}`;
const errorOf = (e: NonNullable<ReplicaStatus["lastError"]>) => `${e.code}: ${clip(e.reason)}`;
/** What a run that has not finished was waiting for, for its deadline line. */
const waitingFor = (s: ReplicaStatus) => `${s.cursor === null ? "the source's first step" : `the cursor ${s.cursor.height} to reach the tip ${s.at?.tipHeight ?? "unknown"}`}${
  s.lastError === null ? " (no answer yet)" : ` (last error ${errorOf(s.lastError)})`}`;

/** Advances until the cursor reaches the tip, a sticky refusal, or the deadline, which also ends an advance in flight;
 *  waits while a step makes no progress. Prints a progress line when the cursor, the tip or the codes change (and every
 *  PROGRESS_MS), and each new source error. */
async function readOn(advance: (signal: AbortSignal) => Promise<ReplicaStatus>, status: () => ReplicaStatus, timeoutMs: number,
  sleep: (ms: number) => Promise<void>, err: (line: string) => void): Promise<{ s: ReplicaStatus; timedOut: boolean }> {
  const end = Date.now() + timeoutMs, stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error("the deadline passed")), timeoutMs);
  let shown = "", shownAt = 0, lastErr = "", wait = 500, last: number | null = null;
  const report = (s: ReplicaStatus) => {
    const p = progressOf(s);
    if (p !== shown || Date.now() - shownAt >= PROGRESS_MS) { err(p); shown = p; shownAt = Date.now(); }
    const e = s.lastError === null ? "" : `${errorOf(s.lastError)}@${s.lastError.at}`;
    if (e !== "" && e !== lastErr) err(`source error ${errorOf(s.lastError!)}`);
    lastErr = e;
  };
  // The advance ends with its signal, but a source's request may settle later: the deadline does not wait for it.
  const bounded = () => Promise.race([advance(stop.signal), new Promise<null>((r) => stop.signal.addEventListener("abort", () => r(null), { once: true }))]);
  try {
    for (;;) {
      const got = stop.signal.aborted ? null : await bounded();
      const s = got ?? status();
      report(s);
      if (got === null || Date.now() >= end) {
        if (caughtUp(s)) return { s, timedOut: false };
        err(`deadline: ${timeoutMs} ms passed waiting for ${waitingFor(s)}`);
        return { s, timedOut: true };
      }
      if (caughtUp(s) || STICKY.has(s.lastError?.code ?? "")) return { s, timedOut: false };
      if ((s.cursor?.height ?? null) === last) { await sleep(Math.min(wait, Math.max(0, end - Date.now()))); wait = Math.min(wait * 2, 30_000); }
      else wait = 500;
      last = s.cursor?.height ?? null;
    }
  } finally { clearTimeout(timer); }
}

/** The command: prints its report through `io.out` and returns the exit code. */
export async function runCheck(argv: readonly string[], raw: CheckIo): Promise<number> {
  const err = raw.err ?? ((l: string) => console.error(l));
  const io: CheckIo = { ...raw, out: (l) => raw.out(printable(l)), err: (l) => err(printable(l)) };
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let a: Args;
  let o: OpenOptions;
  try { a = parse(argv); o = await options(a, io); } catch (e) {
    if (e instanceof Usage || e instanceof ReplicaConfigError) { io.out(`cairnx-replica: ${e.message}`); if (e instanceof Usage) for (const l of e.text.split("\n")) io.out(l); return 2; }
    throw e;
  }
  let replica;
  try { replica = await open(o); } catch (e) {
    if (e instanceof ReplicaConfigError) { io.out(`cairnx-replica: ${e.message}`); return 2; }
    throw e;
  }
  try {
    const { s, timedOut } = await readOn((signal) => replica.advance({ signal }), () => replica.status(), a.timeoutMs, sleep, io.err!);
    const want = a.want, refusal = REFUSED[s.lastError?.code ?? ""];
    const result: Result = timedOut ? "timeout" : refusal !== undefined ? refusal : s.tuple === null ? "no-tuple" : want !== null ? against(s.tuple, want)
      : a.reference !== undefined ? (s.compare?.kind ?? "unavailable") : "held";
    const report = {
      source: s.source, level: s.level, proof: s.proof, verified: s.verified, why: s.why.map((w) => w.code), notes: s.notes.map((n) => n.code),
      cursor: s.cursor, tipHeight: s.at?.tipHeight ?? null, lastError: s.lastError === null ? null : { code: s.lastError.code, reason: clip(s.lastError.reason) },
      tuple: s.tuple, expected: want, compare: s.compare === null ? null : { ...s.compare, detail: s.compare.detail === null ? null : clip(s.compare.detail) }, result,
      exit: EXIT_OF[result],
    };
    if (a.json) io.out(JSON.stringify(report));
    else {
      io.out(`source ${report.source}: level ${report.level}, proof ${report.proof}, ${report.verified ? "verified" : `not verified (${report.why.join(", ")})`}`);
      io.out(`cursor ${report.cursor === null ? "none" : `${report.cursor.height} ${report.cursor.hash}`}, tip ${report.tipHeight ?? "unknown"}${report.lastError === null ? "" : `, last error ${report.lastError.code}: ${report.lastError.reason}`}`);
      io.out(s.tuple === null ? "tuple: no final boundary held" : `tuple ${s.tuple.height} block ${s.tuple.blockHash} events ${s.tuple.eventsHash} state ${s.tuple.stateHash}`);
      if (want !== null || a.reference !== undefined) io.out(`against ${want !== null ? "the expected tuple" : a.reference}: ${result}${report.compare?.detail ? ` (${report.compare.detail})` : ""}`);
      io.out(`result: ${result}, exit ${EXIT_OF[result]}`);
    }
    return EXIT_OF[result];
  } finally {
    let late = false, t: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((r) => { t = setTimeout(() => { late = true; r(); }, CLOSE_GRACE_MS); });
    await Promise.race([replica.close(), grace]);
    clearTimeout(t);
    if (late) io.err!(`the source did not stop within ${CLOSE_GRACE_MS} ms of the deadline; exiting without it`);
  }
}

export interface ServeArgs { readonly node: string; readonly dir: string; readonly host: string; readonly port: number }
/** serve's options, parsed once: `--node` and `--dir` required, `--listen` OPEN_HOST and `--port` OPEN_PORT by default. */
export function parseServe(argv: readonly string[]): ServeArgs {
  const fail = (why: string): never => usage(why, SERVE_USAGE);
  if (argv[0] !== "serve") fail("this is serve's parser");
  const got: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const k = argv[i]!;
    if (!["--node", "--dir", "--listen", "--port"].includes(k)) fail(`unknown argument ${k}`);
    if (got[k] !== undefined) fail(`${k} is given twice: give it once`);
    got[k] = argv[i + 1] ?? fail(`${k} needs a value`);
  }
  const port = got["--port"] === undefined ? OPEN_PORT : heightOf(got["--port"]);
  if (port === null || port > 65_535) fail("--port is a whole number from 0 to 65535");
  if (got["--node"] === undefined || got["--dir"] === undefined) fail("serve needs --node and --dir");
  return { node: got["--node"]!, dir: resolve(got["--dir"]!), host: got["--listen"] ?? OPEN_HOST, port: port! };
}

export interface ServeIo {
  readonly out: (line: string) => void;
  readonly fetch?: typeof fetch;
  /** Called once the server listens, with a stop that closes it and the replica and ends the run with exit 0. */
  readonly ready?: (server: Server, stop: () => Promise<void>) => void;
}
/** The serve command: listens until SIGINT, SIGTERM or `ready`'s stop, then returns the exit code. */
export async function runServe(argv: readonly string[], raw: ServeIo): Promise<number> {
  const out = (l: string) => raw.out(printable(l)), http = raw.fetch === undefined ? {} : { fetch: raw.fetch };
  let a: ServeArgs, reader: Awaited<ReturnType<typeof open>>, answer: ReturnType<typeof openServer>;
  try {
    a = parseServe(argv);
    const own = ownNode({ node: a.node, dir: a.dir, ...http });
    reader = await open({ ...own, pollMs: READ_ADVANCE_MS });
    answer = openServer({ node: a.node, reads: replicaReads(reader), ...http });
  } catch (e) {
    if (e instanceof Usage || e instanceof ReplicaConfigError) { out(`cairnx-replica: ${e.message}`); if (e instanceof Usage) for (const l of e.text.split("\n")) out(l); return 2; }
    throw e;
  }
  let server: Server;
  try { server = await listen(answer, { host: a.host, port: a.port }); } catch (e) {
    out(`cairnx-replica: cannot listen on ${a.host}:${a.port}: ${clip(e instanceof Error ? e.message : String(e))}`);
    await reader.close();
    return 2;
  }
  const port = (server.address() as AddressInfo).port, host = a.host.includes(":") ? `[${a.host}]` : a.host;
  out(`serving http://${host}:${port} from the node ${a.node}, the replica in ${a.dir}`);
  if (!["127.0.0.1", "::1", "localhost"].includes(a.host)) out("a public bind: put a TLS proxy in front of it and limit requests per client there (README)");
  return new Promise((done) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", stop).off("SIGTERM", stop);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await reader.close();
      done(0);
    };
    process.once("SIGINT", stop).once("SIGTERM", stop);
    raw.ready?.(server, stop);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const argv = process.argv.slice(2), io = { out: (l: string) => console.log(l) };
  const code = argv[0] === "serve" ? await runServe(argv, io) : await runCheck(argv, io);
  // A source that did not stop holds the event loop: exit once both streams have flushed.
  await Promise.all([process.stdout, process.stderr].map((w) => new Promise<void>((r) => w.write("", () => r()))));
  process.exit(code);
}
