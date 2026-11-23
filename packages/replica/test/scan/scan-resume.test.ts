// A full pull with waitMaxMs keeps what it read across a stop: every answer read before a later read of the tip block
// gave the hash read before the pull (a confirmation, made after each Retry-After wait). The next scan resumes the pull
// and sends only what it has not read; its result is a fresh scanner's. A pull whose tip block changed, one whose
// confirmation finds another block, and one that failed on what the indexer answered are pulled again from the start.
// Without waitMaxMs a 429 throws as any other status.
import { DOMAIN } from "@inversealtruism/cairnx-core";
import { SourceError } from "../../src/errors.js";
import { Scanner, branchRefusal } from "../../src/scanner.js";
import { done, ok } from "../check.js";
import { fx } from "../core-files.js";
import { captureIndexer } from "../indexer-capture.js";

import { HASH_READ, TIP, host } from "./resume-host.js";

const twice = (served: Map<string, number>) => [...served].filter(([p, n]) => n > 1 && !HASH_READ.test(p.split("?")[0]!));
const sameEvents = (a: { events: unknown[] }, b: { events: unknown[] }) => JSON.stringify(a.events) === JSON.stringify(b.events);
const fresh = await new Scanner({ indexerUrl: "http://idx", fetch: captureIndexer(fx, TIP) }).scan();
ok(`setup: the capture to ${TIP} has events (${fresh.events.length})`, fresh.events.length > 10 && branchRefusal(fresh.anchor) === null);

console.log("a stop after a confirmed wait, then a resume:");
{
  const { h, f } = host(), s = new Scanner({ indexerUrl: "http://idx", fetch: f, waitMaxMs: 60_000 });
  h.refuseAt = 60;
  const e = await s.scan({ due: () => h.n > 60 }).catch((x: unknown) => x);
  ok("the scan whose deadline passes during its first wait stops after it as SOURCE_RATE_LIMITED", e instanceof SourceError && e.code === "SOURCE_RATE_LIMITED", String(e));
  const r = await s.scan();
  ok("the next scan is accepted with a fresh scanner's events", branchRefusal(r.anchor) === null && sameEvents(r, fresh));
  ok("no page, attestation list or transaction is answered twice across the two", twice(h.served).length === 0, JSON.stringify(twice(h.served).slice(0, 3)));
}

console.log("paired, without waitMaxMs: a 429 throws as before, and the next scan pulls again in full");
{
  const { h, f } = host(), s = new Scanner({ indexerUrl: "http://idx", fetch: f });
  h.refuseAt = 60;
  const e = await s.scan({ due: () => h.n > 60 }).catch((x: unknown) => x);
  ok("the 429 throws `-> 429`, no SourceError", e instanceof Error && !(e instanceof SourceError) && / -> 429$/.test(e.message), String(e));
  const r = await s.scan();
  ok("the next scan is a fresh scanner's and reads again what the first read", sameEvents(r, fresh) && twice(h.served).length > 0);
}

console.log("a resumed pull whose tip block changed is pulled again in full:");
{
  const { h, f } = host(), s = new Scanner({ indexerUrl: "http://idx", fetch: f, waitMaxMs: 60_000 });
  h.refuseAt = 60;
  await s.scan({ due: () => h.n > 60 }).catch(() => undefined);
  const other = `0x${"ab".repeat(32)}`;
  h.swap = (p) => (p === `/block-height/${TIP}` ? other : undefined);
  const r = await s.scan();
  ok("accepted at the new block's hash with a fresh scanner's events", r.anchor.hashAfter === other && branchRefusal(r.anchor) === null && sameEvents(r, fresh));
  ok("what the stopped part read is read again", twice(h.served).length > 0);
}

console.log("a confirmation that finds another block refuses the pull, and drops it:");
{
  const { h, f } = host(), s = new Scanner({ indexerUrl: "http://idx", fetch: f, waitMaxMs: 60_000 });
  h.refuseAt = 60;
  const other = `0x${"cd".repeat(32)}`;
  let reads = 0;
  h.swap = (p) => (p === `/block-height/${TIP}` && ++reads >= 2 ? other : undefined);   // the first read is the anchor
  const e = await s.scan().catch((x: unknown) => x);
  ok("the scan is BRANCH_MOVED", e instanceof SourceError && e.code === "BRANCH_MOVED", String(e));
  const r = await s.scan();
  ok("the next scan pulls again from the start at the new block", r.anchor.hashAfter === other && sameEvents(r, fresh) && twice(h.served).length > 0);
}

console.log("a pull that fails on what the indexer answered is dropped:");
{
  const { h, f } = host(), s = new Scanner({ indexerUrl: "http://idx", fetch: f, waitMaxMs: 60_000 });
  h.refuseAt = 60;
  await s.scan({ due: () => h.n > 60 }).catch(() => undefined);
  h.swap = (p) => (p === `/domain/${DOMAIN}/proposals` ? undefined : /^\/proposal\//.test(p) ? { not: "a list" } : undefined);
  const e = await s.scan().catch((x: unknown) => x);
  ok("the resumed pull meets a malformed attestation list and throws", e instanceof Error && /non-array attestations page/.test((e as Error).message), String(e));
  h.swap = null;
  const before = new Map(h.served), r = await s.scan();
  const again = [...h.served].filter(([p, n]) => /^\/tx\//.test(p) && n > (before.get(p) ?? 0) && (before.get(p) ?? 0) > 0);
  ok("the next scan reads the stopped part's transactions again", sameEvents(r, fresh) && again.length > 0);
}

console.log("the signal ends the pull at once, and what was confirmed is kept:");
{
  const { h, f } = host(), s = new Scanner({ indexerUrl: "http://idx", fetch: f, waitMaxMs: 60_000 });
  h.refuseAt = 60;
  const stop = new AbortController();
  h.hangFrom = 80;
  const first = s.scan({ signal: stop.signal });
  while (h.n < 80) await new Promise((x) => setTimeout(x, 1));
  await new Promise((x) => setTimeout(x, 20));
  const t0 = Date.now();
  stop.abort(new Error("the step's deadline"));
  const e = await first.catch((x: unknown) => x);
  ok("the scan rejects with the signal's reason within 100 ms", e instanceof Error && e.message === "the step's deadline" && Date.now() - t0 < 100, `${e instanceof Error ? e.message : typeof e} after ${Date.now() - t0} ms`);
  h.hangFrom = 0;
  const r = await s.scan();
  // the 60th request is refused and the 61st is the confirming read: what was answered before it is confirmed
  const again = twice(h.served), early = again.filter(([p]) => (h.firstAt.get(p) ?? 0) < 61);
  ok("the next scan has a fresh scanner's events; it reads again only what was answered after the confirmation", sameEvents(r, fresh) && again.length > 0 && early.length === 0,
    `${again.length} read twice, ${early.length} of them confirmed`);
}

done("scan-resume");
