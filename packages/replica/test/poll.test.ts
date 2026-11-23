// open() in ./server with `pollMs`: the reader advances at once and again `pollMs` after each advance ends, with no
// read and no caller's advance, and stops at close(); without it nothing advances on its own (a 0.1.0 host that
// drives advance() is unchanged). A pollMs outside 1,000 to 2^31 - 1 or not whole is ReplicaConfigError.
import { ReplicaConfigError, type Source } from "../src/index.js";
import { polled } from "../src/poll.js";
import { open, replicaReads } from "../src/server.js";
import { done, ok } from "./check.js";
import { cap } from "./node-harness.js";
import { nodeSource, timeAt } from "./reader-harness.js";

const settle = (ms: number) => new Promise((x) => setTimeout(x, ms));
const clock = () => timeAt(cap.to) * 1000 + 60_000;
function counted(): { source: Source; steps: () => number } {
  const s = nodeSource();
  let n = 0;
  return { source: { ...s, next: (ctx) => { n++; return s.next(ctx); } }, steps: () => n };
}

console.log("with pollMs 1,000:");
{
  const c = counted(), r = await open({ source: c.source, clock, pollMs: 1_000 });
  await settle(300);
  const first = c.steps(), state = await replicaReads(r)("/cairnx/state");
  ok("it advanced once at open, with no read and no advance() of the caller: synced, served", first >= 1 && r.status().cursor?.height === cap.to && state?.status === 200, `${first} steps`);
  await settle(1_200);
  ok("and again a poll later", c.steps() > first, `${c.steps()} steps`);
  await r.close();
  const closed = c.steps();
  await settle(1_300);
  ok("close() stops it: no step after it", c.steps() === closed, `${closed} then ${c.steps()}`);
}

console.log("the poller itself: no advance after close()");
{
  // A reader whose advance() counts its calls: one closed reader's advance() returns at once, so only this shows a
  // poller left running.
  let calls = 0;
  const inner = await open({ source: nodeSource(), clock });
  const fake = { ...inner, advance: () => { calls++; return Promise.resolve(inner.status()); } };
  const r = polled(fake, 1_000);
  await settle(2_200);
  const before = calls;
  await r.close();
  await settle(1_300);
  ok(`it advanced (${before} calls) and none after close()`, before >= 2 && calls === before, `${before} then ${calls}`);
}

console.log("paired, without pollMs:");
{
  const c = counted(), r = await open({ source: c.source, clock });
  await settle(1_300);
  ok("nothing advances on its own: no step in 1.3 s", c.steps() === 0 && r.status().cursor === null, `${c.steps()} steps`);
  await r.advance();
  ok("the caller's advance() steps as in 0.1.0", c.steps() >= 1 && r.status().cursor?.height === cap.to);
  await r.close();
}

console.log("pollMs out of range:");
for (const bad of [999, 1_000.5, 2 ** 31, 0, -1, Number.NaN]) {
  const e = await open({ source: nodeSource(), clock, pollMs: bad }).then(async (r) => { await r.close(); return null; }, (x: unknown) => x);
  ok(`pollMs ${bad}: ReplicaConfigError`, e instanceof ReplicaConfigError, String(e));
}
{
  const r = await open({ source: nodeSource(), clock, pollMs: 2 ** 31 - 1 });
  ok("paired: pollMs 2^31 - 1 opens", r.status().source.length > 0);
  await r.close();
}

done("poll");
