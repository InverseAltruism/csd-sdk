// Option canon of CsdClient: a non-finite maxResponseBytes or retries falls back to a safe value instead of
// disabling the byte cap or the retry bound. Offline, scripted fetch.
import assert from "node:assert/strict";
import { CsdClient, type ClientOptions } from "../src/index.js";

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

console.log("retries: a non-finite count means no retries");
for (const bad of [NaN, Infinity, -Infinity]) {
  await check(`retries ${bad}: one network failure throws after a single call`, async () => {
    const f = scripted(down, down, sized(100));
    await assert.rejects(mk(f, { retries: bad }).tip(), /ECONNREFUSED/);
    assert.equal(f.calls, 1);
  });
}
await check("finite retries keep their meaning: retries 2 rides out two failures", async () => {
  const f = scripted(down, down, sized(100));
  assert.equal((await mk(f, { retries: 2 }).tip()).height, 7);
  assert.equal(f.calls, 3);
});

console.log(`csd-client option canon: ${pass} passed`);
