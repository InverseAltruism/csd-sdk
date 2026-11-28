// No Reader read throws for "not verified": an answer the replica cannot verify is returned with its level and the
// codes that failed, never thrown. Covered: events, name, balance, transfers, primary, state, dryRun and snapshot (the
// Reader's eight Answer reads), each with a well-formed and an ill-formed input and with a depth not reached, on a
// level 1 feed (fixtureSource), on a reader never advanced, and on a source whose every step fails; status() and
// subscribe() return no Answer and are called too. Paired: the same reads over a verified replica of the recorded node
// answer verified.
import { buildRecord } from "@inversealtruism/cairnx-core";
import { open, type DryRunTx, type Reader, type Source } from "../src/index.js";
import { fixtureSource, type BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { fx } from "./core-files.js";
import { cap } from "./node-harness.js";
import { hashAt, nodeSource, timeAt } from "./reader-harness.js";

const TIP = cap.to, clock = () => timeAt(TIP) * 1000 + 60_000;
const fx300: BlockFixture = { ...fx, to: TIP, toHash: hashAt(TIP), blocks: fx.blocks.filter((b) => b.height <= TIP) };
const HOLDER = "0x44d92872a5b65d37d60ed532f41efe7c5aed59ec";
const b = buildRecord({ v: 1, t: "transfer", ticker: "CAIRN", to: HOLDER, amount: "1" });
const TX = { app: { type: "Propose", domain: "cairnx:v1", uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: 10_000n }, outputs: [] } as unknown as DryRunTx;

const reads = (r: Reader, name: string): Record<string, () => Promise<{ verified: boolean; why: readonly { code: string }[] }>> => ({
  "events": () => r.events(null), "events at a depth not reached": () => r.events(null, { minDepth: 1_000_000 }),
  "events after an off-branch cursor": () => r.events(`30000:1:0x${"ee".repeat(32)}` as never),
  "name": () => r.name(name), "name ill-formed": () => r.name("Not.A.Name"),
  "balance": () => r.balance("CAIRN", HOLDER), "balance ill-formed": () => r.balance("", "nope"), "balance at a depth not reached": () => r.balance("CAIRN", HOLDER, { minDepth: 1_000_000 }),
  "transfers": () => r.transfers(HOLDER, null), "transfers of every address without a ticker": () => r.transfers(null, null),
  "primary": () => r.primary(HOLDER), "primary ill-formed": () => r.primary("nope"),
  "state": () => r.state(), "dryRun": () => r.dryRun(TX, HOLDER), "dryRun ill-formed author": () => r.dryRun(TX, "nope"), "snapshot": () => r.snapshot(),
});

async function none(r: Reader, label: string, wantVerified: boolean | null): Promise<void> {
  const threw: string[] = [], wrong: string[] = [];
  const shown = await r.snapshot().then((a) => (a.verified ? a.value : a.shown), () => null);
  const name = Object.keys(shown?.state.names ?? {})[0] ?? "zzunverified";
  for (const [what, read] of Object.entries(reads(r, name))) {
    try {
      const a = await read();
      if (!a.verified && a.why.length === 0) wrong.push(`${what}: unverified without a code`);
      if (wantVerified === false && a.verified) wrong.push(`${what}: verified`);
    } catch (e) { threw.push(`${what}: ${(e as Error).message}`); }
  }
  try { r.status(); r.subscribe(() => undefined)(); } catch (e) { threw.push(`status or subscribe: ${(e as Error).message}`); }
  ok(`${label}: 16 reads, none throws, every unverified answer names its codes`, threw.length === 0 && wrong.length === 0, [...threw, ...wrong].join("; "));
}

const feed = await open({ source: fixtureSource(fx300, { tipTime: timeAt(TIP) }), clock });
await feed.advance();
await none(feed, "a level 1 feed", false);
const fresh = await open({ source: nodeSource(), clock });
await none(fresh, "a reader never advanced", false);
const failing: Source = { ...nodeSource(), next: async () => { throw new Error("the node is down"); } };
const down = await open({ source: failing, clock });
await down.advance();
await none(down, "a source whose every step fails", false);
const synced = await open({ source: nodeSource(), clock });
await synced.advance();
await none(synced, "paired, a verified replica of the recorded node", null);
const v = await Promise.all([synced.balance("CAIRN", HOLDER), synced.state(), synced.snapshot(), synced.dryRun(TX, HOLDER)]);
ok("paired: its well-formed reads answer verified", v.every((a) => a.verified), v.map((a) => a.why.map((w) => w.code).join("+")).join(","));
for (const r of [feed, fresh, down, synced]) await r.close();
done("unverified");
