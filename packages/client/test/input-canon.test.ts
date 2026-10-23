// Option canon of CsdClient: a non-finite maxResponseBytes or retries falls back to a safe value instead of
// disabling the byte cap or the retry bound; the default body parser keeps u64 literals exact. Offline, scripted fetch.
import assert from "node:assert/strict";
import { txid, type Tx } from "@inversealtruism/csd-codec";
import { CsdClient, rpcTxToTx, type ClientOptions } from "../src/index.js";

let pass = 0;
const check = async (name: string, fn: () => Promise<void>) => { await fn(); pass++; console.log(`  ok ${name}`); };

const TIP = { tip: "0x" + "0".repeat(64), height: 7, chainwork: "1" };
const DEFAULT_CAP = 16 * 1024 * 1024;
const sized = (contentLength: number) => () => new Response(JSON.stringify(TIP), { status: 200, headers: { "content-length": String(contentLength) } });
const scripted = (...handlers: (() => Response)[]) => {
  const f = Object.assign(async (): Promise<Response> => { f.calls++; return handlers[Math.min(f.calls - 1, handlers.length - 1)]!(); }, { calls: 0 });
  return f;
};
const mk = (f: ReturnType<typeof scripted>, opts: Partial<ClientOptions> = {}) =>
  new CsdClient({ baseUrl: "http://scripted", fetch: f as unknown as typeof fetch, ...opts });
const down = () => { throw new Error("ECONNREFUSED"); };

console.log("maxResponseBytes: a non-finite cap falls back to the default");
for (const bad of [NaN, Infinity]) {
  await check(`maxResponseBytes ${bad}: a body over the default cap is refused`, async () => {
    await assert.rejects(mk(scripted(sized(DEFAULT_CAP + 1)), { maxResponseBytes: bad }).tip(), /too large/);
  });
  await check(`maxResponseBytes ${bad}: a body under the default cap is read`, async () => {
    assert.equal((await mk(scripted(sized(100)), { maxResponseBytes: bad }).tip()).height, 7);
  });
}
await check("finite caps keep their meaning (default, explicit, and the floor of 1)", async () => {
  await assert.rejects(mk(scripted(sized(DEFAULT_CAP + 1))).tip(), /too large/);
  assert.equal((await mk(scripted(sized(DEFAULT_CAP))).tip()).height, 7);
  await assert.rejects(mk(scripted(sized(1001)), { maxResponseBytes: 1000 }).tip(), /too large/);
  await assert.rejects(mk(scripted(sized(2)), { maxResponseBytes: 0 }).tip(), /too large/);
});

console.log("retries: a non-finite count falls back to the default (0 retries)");
for (const bad of [NaN, Infinity, -Infinity]) {
  await check(`retries ${bad}: behaves as the option omitted (one network failure throws after a single call)`, async () => {
    const f = scripted(down, down, sized(100));
    await assert.rejects(mk(f, { retries: bad }).tip(), /ECONNREFUSED/);
    const g = scripted(down, down, sized(100));
    await assert.rejects(mk(g).tip(), /ECONNREFUSED/);
    assert.equal(f.calls, 1);
    assert.equal(f.calls, g.calls);
  });
}
await check("finite retries keep their meaning: retries 2 rides out two failures", async () => {
  const f = scripted(down, down, sized(100));
  assert.equal((await mk(f, { retries: 2 }).tip()).height, 7);
  assert.equal(f.calls, 3);
});

console.log("parseJson: the default keeps an integer above 2^53 exact (a Propose's expires_epoch is an unbounded u64)");
{
  const EE = 9007199254740993n;   // 2^53 + 1: JSON.parse reads it as 2^53
  const tx: Tx = {
    version: 1, locktime: 0,
    inputs: [{ prevTxid: "0x" + "11".repeat(32), vout: 0, scriptSig: "0x" }],
    outputs: [{ value: 25_000_000, scriptPubkey: "0x" + "22".repeat(20) }],
    app: { type: "Propose", domain: "cairnx:v1", payloadHash: "0x" + "33".repeat(32), uri: "u", expiresEpoch: EE },
  };
  const id = txid(tx);
  // the node's JSON shape, u64 written as a bare literal; `ratio` is a float literal the parse must leave alone
  const body = `{"ok":true,"hash":"0x${"44".repeat(32)}","ratio":1e20,"half":0.5,"header":{"version":1,"prev":"0x${"00".repeat(32)}","merkle":"0x${"00".repeat(32)}","time":1,"bits":1,"nonce":0},` +
    `"txs":[{"txid":"${id}","version":1,"locktime":0,"inputs":[{"prev_txid":"0x${"11".repeat(32)}","vout":0,"script_sig":"0x"}],` +
    `"outputs":[{"value":25000000,"script_pubkey":"0x${"22".repeat(20)}"}],` +
    `"app":{"type":"Propose","domain":"cairnx:v1","payload_hash":"0x${"33".repeat(32)}","uri":"u","expires_epoch":${EE}}}]}`;
  const served = scripted(() => new Response(body, { status: 200 }));
  await check("a block body read with the default parser re-derives the exact txid", async () => {
    const b = await mk(served).blockByHash("0x" + "44".repeat(32));
    assert.equal(b.txs[0]!.app.type === "Propose" && b.txs[0]!.app.expires_epoch, EE);
    assert.equal(txid(rpcTxToTx(b.txs[0]!)), id);
    assert.equal((b as unknown as { ratio: unknown }).ratio, 1e20);
    assert.equal((b as unknown as { half: unknown }).half, 0.5);
    assert.equal(b.txs[0]!.outputs[0]!.value, 25_000_000);
  });
  await check("a caller-supplied parseJson is still used", async () => {
    const b = await mk(scripted(() => new Response(body, { status: 200 })), { parseJson: JSON.parse }).blockByHash("0x" + "44".repeat(32));
    assert.throws(() => txid(rpcTxToTx(b.txs[0]!)), /unsafe number/);
  });
}

console.log(`csd-client option canon: ${pass} passed`);
