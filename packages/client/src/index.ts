// @inversealtruism/csd-client — a typed HTTP client over the Compute Substrate node RPC. Pluggable base URL
// (a direct node, the Cairn proxy `…/api/rpc`, or — later — a csd:gateways-discovered endpoint)
// and a pluggable fetch (for tests / non-DOM runtimes). Read + broadcast; no trust assumptions
// (the light client in @inversealtruism/csd-light verifies what this returns).
import type { Tx, BlockHeader } from "@inversealtruism/csd-codec";
import { txid as codecTxid } from "@inversealtruism/csd-codec";

export interface RpcHeaderJson { version: number; prev: string; merkle: string; time: number; bits: number; nonce: number }
export interface RpcTxJson {
  txid: string;
  version: number;
  inputs: { prev_txid: string; vout: number; script_sig: string; script_sig_text?: string | null }[];
  outputs: { value: number; script_pubkey: string }[];
  locktime: number;
  app: { type: "None" } | { type: "Propose"; domain: string; payload_hash: string; uri: string; expires_epoch: number } | { type: "Attest"; proposal_id: string; score: number; confidence: number };
}
export interface RpcBlock { ok: boolean; hash: string; height?: number; chainwork?: string; header: RpcHeaderJson; txs: RpcTxJson[] }
export interface RpcTip { tip: string; height: number; chainwork: string }
export interface RpcUtxo { txid: string; vout: number; value: number; height: number; confirmations: number; coinbase: boolean }
export interface RpcUtxos { ok: boolean; addr20: string; count: number; confirmed_balance: number; utxos: RpcUtxo[] }
export interface RpcSubmit { ok: boolean; txid: string; mempool_len?: number; err?: string | null }

export interface RpcProposal {
  ok?: boolean; txid: string; domain: string; payload_hash: string; uri: string;
  expires_epoch: number; proposer: string; height: number; attestations?: unknown[];
  [k: string]: unknown;
}
export interface RpcTxInfo { ok: boolean; txid: string; block_hash?: string; height?: number; time?: number; tx?: RpcTxJson; err?: string }
export interface RpcHealth { ok: boolean; height?: number; peers?: number; mempool_len?: number; [k: string]: unknown }
export interface WaitForTxResult { txid: string; height: number; confirmations: number }

export interface ClientOptions {
  baseUrl: string; fetch?: typeof fetch; timeoutMs?: number;
  /** retry NETWORK failures (timeouts, refused, 5xx) this many times with jittered backoff.
   *  NEVER retries an application result (`ok:false`) or 4xx — those are answers, not outages. */
  retries?: number;
  /**
   * Hard ceiling (bytes) on a response body before it is parsed. A lying/malicious node can
   * otherwise stream a multi-hundred-MB body that the verifier buffers (`await r.json()`) and
   * OOM-crashes BEFORE any PoW/merkle/LWMA check runs — a remote DoS of the trusted light-client
   * path (audit M2). Default 16 MiB ≫ any real block; raise it for an unusually large block source.
   */
  maxResponseBytes?: number;
}

export class CsdClient {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxBytes: number;
  constructor(opts: ClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.maxBytes = Math.max(1, opts.maxResponseBytes ?? 16 * 1024 * 1024);
    // BIND the default global fetch to the global. In browsers `fetch` is branded: calling it as a
    // method of another object (`this.f(url)`) throws `TypeError: Illegal invocation`. Storing the bare
    // `globalThis.fetch` and invoking it via `this.f` did exactly that, so any browser consumer that
    // didn't pass `opts.fetch` (e.g. cairn-sdk dApps) broke. A caller-supplied fetch is used as-is.
    const gf = globalThis.fetch;
    this.f = opts.fetch ?? (gf ? gf.bind(globalThis) : gf);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = Math.max(0, opts.retries ?? 0);
    if (!this.f) throw new Error("no fetch available — pass opts.fetch");
  }

  private async req<T>(path: string, init?: RequestInit, opts?: { noRetry?: boolean }): Promise<T> {
    // L13: a NON-idempotent broadcast (submit) must NOT be auto-resent on a 5xx/timeout — a re-send
    // can double-broadcast. Only idempotent GETs (and the pure template POSTs) use the retry budget.
    const maxRetries = opts?.noRetry ? 0 : this.retries;
    let lastErr: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.f(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
        if (r.status >= 500 && attempt < maxRetries) { lastErr = new Error(`HTTP ${r.status}`); }
        // 4xx is an answer, not an outage: mark it terminal so the catch below cannot spend the
        // retry budget on it (pre-fix, the thrown 4xx landed in the same catch as network errors
        // and WAS retried, violating the documented `retries` contract; found by hostile.test.ts).
        else if (!r.ok) throw Object.assign(new Error(`${init?.method ?? "GET"} ${path} → HTTP ${r.status}`), { terminal: r.status < 500 });
        else return (await this.readCapped(r, path)) as T;
      } catch (e) {
        if (attempt >= maxRetries || (e as { terminal?: boolean } | null)?.terminal) throw e;
        lastErr = e;
      }
      // full-jitter backoff: 250ms·2^attempt, capped at 5s
      const cap = Math.min(5_000, 250 * 2 ** attempt);
      await new Promise((res) => setTimeout(res, Math.floor(Math.random() * cap)));
      void lastErr;
    }
  }
  /**
   * Read a response body as JSON with a hard byte ceiling (`maxResponseBytes`). Rejects an
   * oversized `Content-Length` up front, and otherwise streams the body and aborts the moment
   * it exceeds the cap — so a malicious node cannot make us buffer a giant body and OOM before
   * we ever validate it (audit M2). Falls back to a size-checked `text()` on runtimes without a
   * streaming body (older MV3/Node), preserving the cap as a best effort.
   */
  private async readCapped(r: Response, path: string): Promise<unknown> {
    const max = this.maxBytes;
    const cl = r.headers.get("content-length");
    if (cl && Number(cl) > max) throw new Error(`GET ${path} → response too large (${cl} > ${max} bytes)`);
    const body = (r as { body?: ReadableStream<Uint8Array> | null }).body;
    if (!body || typeof body.getReader !== "function") {
      const t = await r.text();
      // Cap on BYTES, not UTF-16 code units (audit L5): a body of multibyte chars is up to ~3-4× its
      // String.length in bytes, so a `t.length` check let a 16 MiB cap pass a ~48 MiB body.
      const byteLen = new TextEncoder().encode(t).length;
      if (byteLen > max) throw new Error(`GET ${path} → response too large (${byteLen} > ${max} bytes)`);
      return JSON.parse(t);
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > max) { try { await reader.cancel(); } catch { /* no-op */ } throw new Error(`GET ${path} → response exceeded ${max} bytes`); }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    return JSON.parse(new TextDecoder().decode(buf));
  }

  private get<T>(path: string): Promise<T> { return this.req<T>(path); }
  private post<T>(path: string, body: unknown, opts?: { noRetry?: boolean }): Promise<T> {
    return this.req<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, opts);
  }

  // The node returns application errors as `{ok:false, err}` with HTTP **200**, so a bare `get()`
  // can't see them. For endpoints whose `{ok:false}` result is useless to the caller (a missing
  // block), surface it as a thrown error — otherwise a beyond-tip/not-found block flows downstream
  // as a malformed object and crashes opaquely (e.g. the light client reading `header.prev`).
  private async getOk<T extends { ok?: boolean; err?: string | null }>(path: string): Promise<T> {
    const j = await this.get<T>(path);
    if (j && j.ok === false) throw new Error(`GET ${path} → node error: ${j.err ?? "ok:false"}`);
    return j;
  }

  tip(): Promise<RpcTip> { return this.get("/tip"); }
  health(): Promise<RpcHealth> { return this.get("/health"); }
  blockByHeight(h: number): Promise<RpcBlock> { return this.getOk(`/block/height/${h}`); }
  blockByHash(hash: string): Promise<RpcBlock> { return this.getOk(`/block/${hash}`); }
  tx(id: string): Promise<RpcTxInfo> { return this.get(`/tx/${id}`); }
  // Default available=true: excludes immature/locked coinbase UTXOs so callers don't build txs spending
  // un-spendable outputs (the node would silently reject them) — audit TXB-1-SDK. Pass {available:false}
  // for the full set (e.g. balance display that wants to show locked coinbases).
  utxos(addr: string, opts: { available?: boolean } = {}): Promise<RpcUtxos> {
    return this.get(`/utxos/${addr}${opts.available === false ? "" : "?available=true"}`);
  }
  // getOk: a not-found proposal returns {ok:false}@200; without this the caller reads .domain/.uri off a
  // malformed object instead of seeing the error (audit M6). (tx() deliberately keeps its bare get — its
  // {ok:false} is a documented VALID "not yet in a block" state that waitForTx/verifyInputValues handle.)
  proposal(id: string): Promise<RpcProposal> { return this.getOk(`/proposal/${id}`); }
  proposals(domain: string, limit = 40): Promise<RpcProposal[]> { return this.get(`/proposals/${encodeURIComponent(domain)}/${limit}`); }
  topDomain(domain: string, epoch?: number): Promise<unknown> { return this.get(epoch == null ? `/top/${encodeURIComponent(domain)}` : `/top/${encodeURIComponent(domain)}/${epoch}`); }
  domains(): Promise<string[]> { return this.get("/domains"); }
  mempool(): Promise<unknown> { return this.get("/mempool"); }

  /**
   * Await a txid reaching `confirmations` (default 1) — the submit-then-confirm flow every
   * consumer was hand-rolling. Polls /tx + /tip; resolves {txid, height, confirmations};
   * rejects on timeout (default 10 min — CSD blocks are ~2 min but the live miner is lumpy).
   * A tx that drops OUT of the chain mid-wait (reorg) keeps polling until it re-confirms or
   * times out — never resolves on a stale sighting.
   */
  async waitForTx(txid: string, opts: { confirmations?: number; timeoutMs?: number; pollMs?: number } = {}): Promise<WaitForTxResult> {
    const want = Math.max(1, opts.confirmations ?? 1);
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    const poll = Math.max(500, opts.pollMs ?? 5_000);
    for (;;) {
      try {
        const t = await this.tx(txid);
        if (t.ok && t.height != null) {
          const tip = await this.tip();
          const conf = tip.height - t.height + 1;
          if (conf >= want) return { txid, height: t.height, confirmations: conf };
        }
      } catch { /* transient read failure — keep waiting */ }
      if (Date.now() > deadline) throw new Error(`waitForTx ${txid}: not at ${want} confirmation(s) within ${opts.timeoutMs ?? 600_000}ms`);
      await new Promise((res) => setTimeout(res, poll));
    }
  }

  /**
   * Broadcast a node-JSON tx (from @inversealtruism/csd-tx `txToNodeJson`).
   * ⚠ The node returns `{ok:false, err}` with HTTP 200 on REJECTION — and **`txid` is populated even
   * then** (it's the computed id of the rejected tx). Callers MUST check `.ok`; reading `.txid`
   * alone mistakes a rejected tx for a broadcast one. Use `submitOrThrow` if you want a hard failure.
   */
  submit(nodeJsonTx: unknown): Promise<RpcSubmit> { return this.post("/tx/submit", { tx: nodeJsonTx }, { noRetry: true }); }
  /** As `submit`, but throws on node rejection (`ok:false`) instead of returning a misleading txid. */
  async submitOrThrow(nodeJsonTx: unknown): Promise<RpcSubmit> {
    const r = await this.submit(nodeJsonTx);
    if (!r.ok) throw new Error(`tx rejected by node: ${r.err ?? "unknown error"}`);
    return r;
  }
  templatePropose(body: unknown): Promise<unknown> { return this.post("/tx/template/propose", body); }
  templateAttest(body: unknown): Promise<unknown> { return this.post("/tx/template/attest", body); }
}

/** Convert a node /tx or /block tx JSON back into the codec's Tx struct (for re-verification). */
export function rpcTxToTx(j: RpcTxJson): Tx {
  const app = j.app.type === "None"
    ? { type: "None" as const }
    : j.app.type === "Propose"
      ? { type: "Propose" as const, domain: j.app.domain, payloadHash: j.app.payload_hash, uri: j.app.uri, expiresEpoch: j.app.expires_epoch }
      : { type: "Attest" as const, proposalId: j.app.proposal_id, score: j.app.score, confidence: j.app.confidence };
  return {
    version: j.version, locktime: j.locktime, app,
    inputs: j.inputs.map((i) => ({ prevTxid: i.prev_txid, vout: i.vout, scriptSig: i.script_sig })),
    outputs: j.outputs.map((o) => ({ value: o.value, scriptPubkey: o.script_pubkey })),
  };
}

/** UTXO-VALUE-1 cure (audit). A CSD fee is implicit (Σin − Σout) and uncapped by consensus, so a
 *  builder that trusts a hostile RPC's /utxos `value` can compute too-small a change and silently
 *  BURN the difference as fee. This confirms each selected input's REAL value by fetching its source
 *  tx and RECOMPUTING its txid with the consensus codec — the txid commits to the output values, so
 *  a forged body whose recomputed txid still matches the prevout is impossible. Fail-CLOSED: any
 *  unreachable/forged/missing source aborts. Returns the verified input total (use it to compute
 *  change from REAL values, not the reported ones). RPC-facing builders (wallet, cairn-sdk) should
 *  call this before assembling a spend; csd-tx itself is pure and cannot fetch.
 *  (Mirrors the proven cairn-wallet `node.ts` implementation; the wallet's TXB-1 cure made canonical.) */
export async function verifyInputValues(
  client: { tx(id: string): Promise<RpcTxInfo> },
  inputs: { txid: string; vout: number }[],
): Promise<{ ok: boolean; total: number }> {
  const norm = (s: string) => String(s).toLowerCase().replace(/^0x/, "");
  let total = 0;
  for (const i of inputs) {
    let info: RpcTxInfo; try { info = await client.tx(i.txid); } catch { return { ok: false, total: 0 }; }
    // accept both the {ok, tx:{…}} envelope and a bare tx body (two node response shapes)
    const body = (info?.tx ?? info) as RpcTxJson | undefined;
    if (!body || !Array.isArray(body.outputs) || !Array.isArray(body.inputs)) return { ok: false, total: 0 };
    // codecTxid() must be INSIDE the try: a hostile source body (e.g. a wrong-length scriptPubkey) makes
    // it throw, and an uncaught throw here would crash the caller instead of failing closed (audit M2).
    let tx: Tx, idHex: string;
    try { tx = rpcTxToTx(body); idHex = codecTxid(tx); } catch { return { ok: false, total: 0 }; }
    if (norm(idHex) !== norm(i.txid)) return { ok: false, total: 0 }; // forged source body
    const out = tx.outputs[i.vout];
    if (!out) return { ok: false, total: 0 };
    const v = Number(out.value);
    if (!Number.isSafeInteger(v) || v <= 0) return { ok: false, total: 0 };
    total += v;
    if (!Number.isSafeInteger(total)) return { ok: false, total: 0 };
  }
  return { ok: true, total };
}

/** Convert a node /block header JSON into the codec's BlockHeader. */
export function rpcHeaderToHeader(h: RpcHeaderJson): BlockHeader {
  return { version: h.version, prev: h.prev, merkle: h.merkle, time: h.time, bits: h.bits, nonce: h.nonce };
}
