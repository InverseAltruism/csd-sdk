// The kill test of diskStore: an uninterrupted run of the sequence (disk-kill-sequence.ts) records every truncate,
// write, sync and rename point of every commit; each point, and a half-written buffer at each write point, is one
// SIGKILL of a child process running the same sequence. After each kill the store must open, not corrupt, at the
// cursor before or after the commit that was cut, and the sequence run on from there must end at the uninterrupted
// run's cursor and events hash. A kill keeps the page cache, so this test cannot see a missing sync; the sync order is
// disk-store.test.ts's.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STALE_MS } from "../src/lease.js";
import { done, ok } from "./check.js";
import { runSequence } from "./disk-kill-sequence.js";

const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const CHILD = fileURLToPath(new URL("./disk-kill-child.ts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "cairnx-replica-kill-"));
const child = (dir: string, at?: string) => new Promise<{ status: number | null; signal: NodeJS.Signals | null; out: string }>((go) => {
  const c = spawn(TSX, [CHILD, dir, ...(at ? [at] : [])], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  c.stdout.on("data", (d) => { out += d; });
  c.on("exit", (status, signal) => go({ status, signal, out }));
});

const ref = JSON.parse((await child(join(root, "ref"))).out) as { trace: string[]; cursors: string[]; cursor: unknown; eventsHash: string };
// The points in order, numbered by commit; the cursor each commit leaves (after[0]: none yet).
const points: { commit: number; name: string; half: boolean }[] = [], after = [JSON.stringify(null), ...ref.cursors];
let commit = 1;
for (const name of ref.trace) {
  points.push({ commit, name, half: false });
  if (name.startsWith("write ")) points.push({ commit, name, half: true });
  if (name === "done") commit++;
}

console.log(`kill test: ${points.length} kill points over ${commit - 1} commits`);
ok("the sequence holds every commit kind: a rollback (a commit with no rows written) and the cut of its tail after it",
  ref.trace.includes("truncate rows.jsonl") && ref.trace.includes("truncate bounds.jsonl") && commit - 1 >= 15);
ok("the kill points number at least 200", points.length >= 200, String(points.length));

const late = () => Date.now() + STALE_MS + 1;   // the killed child's lease is stale to the parent at once
let killed = 0, opened = 0, between = 0, ended = 0;
const bad: string[] = [];
let next = 0;
async function worker() {
  for (let i = next++; i < points.length; i = next++) {
    const p = points[i]!, dir = join(root, `k${i}`);
    const k = await child(dir, `${p.commit}:${p.name}${p.half ? ":half" : ""}`);
    if (k.signal === "SIGKILL" || k.status === 137) killed++;
    const r = await runSequence(dir, { sync: false, clock: late });
    if (r.opened.ok) opened++;
    const where = JSON.stringify(r.openedAt);
    if (r.opened.ok && (where === after[p.commit - 1] || where === after[p.commit])) between++;
    if (JSON.stringify(r.cursor) === JSON.stringify(ref.cursor) && r.eventsHash === ref.eventsHash && r.lastError === null) ended++;
    else bad.push(`${p.commit}:${p.name}:${p.half}`);
    rmSync(dir, { recursive: true, force: true });
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
ok(`every one of the ${points.length} children was killed at its point`, killed === points.length, String(killed));
ok("every killed store opens, not corrupt", opened === points.length, String(opened));
ok("each opens at the cursor before or after the commit that was cut", between === points.length, String(between));
ok("each, run on, ends at the uninterrupted run's cursor and events hash", ended === points.length, bad.slice(0, 5).join(" "));
rmSync(root, { recursive: true, force: true });
done("cairnx-replica disk kill");
