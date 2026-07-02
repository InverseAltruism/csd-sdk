// @inversealtruism/csd-client OFFLINE hostile-boundary tests (Plan 56 A.3 finding 4; Plan 57 B1).
// client.test.ts proves codec round-trips against a real node; THIS file proves the defensive
// seams with a scripted fetch, no network: retry classification (network/5xx only, never 4xx,
// never submit), the readCapped byte ceiling (content-length up-front, mid-stream abort, and the
// UTF-16-vs-bytes fallback subtlety), waitForTx's reorg/stale-sighting discipline, and
// verifyInputValues fail-closed behavior on forged/unreachable sources.
import { CsdClient, verifyInputValues } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };
const json = (obj: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(obj), { status: 200, ...init });

// scripted fetch: call N gets handler N (last handler repeats); records call count
type Handler = () => Response | Promise<Response>;
const scripted = (...handlers: Handler[]) => {
  const f = Object.assign(
    async (_url: unknown, _init?: unknown): Promise<Response> => {
      f.calls++;
      return handlers[Math.min(f.calls - 1, handlers.length - 1)]();
    },
    { calls: 0 },
  );
  return f;
};
const mk = (f: ReturnType<typeof scripted>, opts: Partial<ConstructorParameters<typeof CsdClient>[0]> = {}) =>
  new CsdClient({ baseUrl: "http://scripted", fetch: f as unknown as typeof fetch, ...opts });

console.log("retry classification (network/5xx only):");
{
  const f = scripted(() => { throw new Error("ECONNREFUSED"); }, () => json({ tip: "0x" + "0".repeat(64), height: 1, chainwork: "1" }));
  const t = await mk(f, { retries: 1 }).tip();
  ok("network failure is retried and then succeeds", t.height === 1 && f.calls === 2);
}
{
  const f = scripted(() => new Response("boom", { status: 500 }), () => new Response("boom", { status: 503 }), () => json({ tip: "0x" + "0".repeat(64), height: 2, chainwork: "1" }));
  const t = await mk(f, { retries: 2 }).tip();
  ok("5xx is retried within budget and then succeeds", t.height === 2 && f.calls === 3);
}
{
  const f = scripted(() => new Response("boom", { status: 500 }));
  const err = await mk(f).tip().then(() => null, (e: Error) => e);
  ok("default retries=0: a 5xx throws immediately", err !== null && f.calls === 1);
}
{
  const f = scripted(() => new Response("nope", { status: 404 }));
  const err = await mk(f, { retries: 3 }).tip().then(() => null, (e: Error) => e);
  ok("4xx is an answer, not an outage: no retry even with budget", err !== null && /404/.test(String(err)) && f.calls === 1);
}
{
  const f = scripted(() => { throw new Error("ECONNRESET"); });
  const err = await mk(f, { retries: 3 }).submit({}).then(() => null, (e: Error) => e);
  ok("submit NEVER retries (double-broadcast guard): 1 call despite retries=3", err !== null && f.calls === 1);
}
{
  const f = scripted(() => json({ ok: false, txid: "0x" + "d".repeat(64), err: "fee too low" }));
  const err = await mk(f, { retries: 3 }).submitOrThrow({}).then(() => null, (e: Error) => e);
  ok("submitOrThrow surfaces node rejection (txid-populated footgun)", err !== null && /fee too low/.test(String(err)) && f.calls === 1);
}
{
  const f = scripted(() => json({ ok: false, err: "not found" }));
  const err = await mk(f, { retries: 3 }).blockByHeight(99).then(() => null, (e: Error) => e);
  ok("app-level ok:false at HTTP 200 is not retried (getOk throws once)", err !== null && /not found/.test(String(err)) && f.calls === 1);
}

console.log("readCapped byte ceiling:");
{
  const f = scripted(() => new Response("{}", { status: 200, headers: { "content-length": "999999999" } }));
  const err = await mk(f, { maxResponseBytes: 1000 }).tip().then(() => null, (e: Error) => e);
  ok("oversized content-length is rejected up front", err !== null && /too large/.test(String(err)));
}
{
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(1024).fill(32)); c.enqueue(new Uint8Array(1024).fill(32)); c.close(); },
  });
  const f = scripted(() => new Response(stream, { status: 200 }));
  const err = await mk(f, { maxResponseBytes: 1500 }).tip().then(() => null, (e: Error) => e);
  ok("streaming body is aborted the moment it exceeds the cap", err !== null && /exceeded 1500 bytes/.test(String(err)));
}
{
  // no-stream runtime fallback (older MV3/Node): cap must count BYTES, not UTF-16 code units.
  // 8 euro signs = 10 JSON chars (String.length) but 26 bytes; a length check would pass a 16-byte cap.
  const fake = { status: 200, ok: true, headers: { get: () => null }, body: null, text: async () => JSON.stringify("€".repeat(8)) };
  const f = scripted(() => fake as unknown as Response);
  const err = await mk(f, { maxResponseBytes: 16 }).tip().then(() => null, (e: Error) => e);
  ok("text() fallback caps on bytes, not string length (UTF-16 subtlety)", err !== null && /too large/.test(String(err)));
}
{
  const fake = { status: 200, ok: true, headers: { get: () => null }, body: null, text: async () => JSON.stringify({ tip: "0x" + "0".repeat(64), height: 7, chainwork: "1" }) };
  const f = scripted(() => fake as unknown as Response);
  const t = await mk(f).tip();
  ok("text() fallback under the cap still parses", t.height === 7);
}

console.log("waitForTx reorg/stale-sighting discipline:");
{
  const tx = (h: number | null) => (h == null ? { ok: false, txid: "0x" + "a".repeat(64) } : { ok: true, txid: "0x" + "a".repeat(64), height: h });
  const tip = (h: number) => ({ tip: "0x" + "0".repeat(64), height: h, chainwork: "1" });
  // want 3 confirmations. Sighting at h=100 (conf 1, keep polling), then the tx REORGS OUT
  // (ok:false, no tip call), then re-confirms at h=105 with tip 107 (conf 3) -> resolve.
  const f = scripted(
    () => json(tx(100)), () => json(tip(100)),
    () => json(tx(null)),
    () => json(tx(105)), () => json(tip(107)),
  );
  const r = await mk(f).waitForTx("0x" + "a".repeat(64), { confirmations: 3, pollMs: 1, timeoutMs: 30_000 });
  ok("a stale pre-reorg sighting never resolves; resolves on re-confirmation", r.height === 105 && r.confirmations === 3 && f.calls === 5);
}
{
  const f = scripted(() => json({ ok: false, txid: "0x" + "a".repeat(64) }));
  const err = await mk(f).waitForTx("0x" + "a".repeat(64), { confirmations: 1, pollMs: 1, timeoutMs: 600 }).then(() => null, (e: Error) => e);
  ok("waitForTx times out (rejects) instead of hanging", err !== null && /not at 1 confirmation/.test(String(err)));
}

console.log("verifyInputValues fail-closed:");
{
  // 20-byte spk so the body round-trips the codec cleanly: the recomputed txid is then a REAL
  // txid that mismatches the requested one, exercising the forgery comparison itself (a wrong
  // spk length would throw earlier and only cover the try/catch fail-closed path).
  const forged = {
    ok: true, txid: "0x" + "1".repeat(64),
    tx: { txid: "0x" + "1".repeat(64), version: 1, inputs: [], outputs: [{ value: 5_000_000, script_pubkey: "00".repeat(20) }], locktime: 0, app: { type: "None" } },
  };
  const r = await verifyInputValues({ tx: async () => forged as never }, [{ txid: "0x" + "1".repeat(64), vout: 0 }]);
  ok("forged source body (recomputed txid mismatch) -> ok:false", r.ok === false && r.total === 0);
}
{
  const r = await verifyInputValues({ tx: async () => { throw new Error("down"); } }, [{ txid: "0x" + "1".repeat(64), vout: 0 }]);
  ok("unreachable source -> ok:false (never a guessed total)", r.ok === false && r.total === 0);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
