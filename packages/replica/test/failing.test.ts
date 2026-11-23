// A source whose steps fail: once no step has settled for more than FAILING_MS (30 minutes) and the last one failed,
// every answer carries the note SOURCE_FAILING and a replica's server withholds it (503). The honest neighbours: a
// failed step right after a good one, failing for 29 minutes, and a good step after the note, each withhold nothing.
import type { Source } from "../src/index.js";
import { open, replicaReads } from "../src/server.js";
import { FAILING_MS } from "../src/verdict.js";
import { done, ok } from "./check.js";
import { cap } from "./node-harness.js";
import { nodeSource, timeAt } from "./reader-harness.js";

const MIN = 60_000, TIP = cap.to;
ok("FAILING_MS is 30 minutes", FAILING_MS === 30 * MIN);
let down = false, now = timeAt(TIP) * 1000 + MIN;
const node = nodeSource();
// The recorded node, or a node that refuses every step (a host restart, an outage).
const source: Source = { ...node, next: (ctx) => (down ? Promise.resolve({ kind: "cannot", code: "SOURCE_UNAVAILABLE", reason: "the node is down", retryAfterMs: 0 }) : node.next(ctx)) };
const r = await open({ source, clock: () => now });
const reads = replicaReads(r);
const notes = () => r.status().notes.map((n) => n.code);
const resolve = async () => (await reads("/cairnx/state"))!;

const good = await r.advance();
ok("setup: synced at the recorded tip, served", good.cursor?.height === TIP && good.lastError === null && (await resolve()).status === 200);

down = true;
await r.advance();
ok("a failed step right after a good one: no SOURCE_FAILING, served", r.status().lastError?.code === "SOURCE_UNAVAILABLE" && !notes().includes("SOURCE_FAILING") && (await resolve()).status === 200);

now += 29 * MIN;
await r.advance();
ok("steps failing, the last settled 29 minutes ago: no SOURCE_FAILING, served", !notes().includes("SOURCE_FAILING") && (await resolve()).status === 200, notes().join(","));

now += 2 * MIN;
await r.advance();
const withheld = await resolve(), note = r.status().notes.find((n) => n.code === "SOURCE_FAILING");
ok("steps failing, the last settled 31 minutes ago: SOURCE_FAILING with its detail, 503", note?.detail === "no step settled for 31 minutes; the last error SOURCE_UNAVAILABLE" &&
  withheld.status === 503 && withheld.headers["x-cairnx-notes"]?.split(",").includes("SOURCE_FAILING") === true, `${withheld.status} ${withheld.headers["x-cairnx-notes"]} ${JSON.stringify(note)}`);

down = false;
await r.advance();
ok("a good step after it: the note gone, served again", !notes().includes("SOURCE_FAILING") && (await resolve()).status === 200, notes().join(","));
await r.close();

done("failing");
