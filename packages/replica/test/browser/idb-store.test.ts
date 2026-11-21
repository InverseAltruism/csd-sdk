// idbStore (idb-store.ts) in a real MV3 service worker: the store suite; the reader over idbStore and sessionSlot after
// a worker stop; the worker stopped at each point of a commit's slot writes, mid-transaction and at random times, each
// reopening confirmed and running on to the uninterrupted cursor and events hash; a browser start (the slot empty) and
// a consistent forgery of the profile, each reset and refilled, beside the forgery with the slot made to name it, which
// opens; the Web Lock against a second store and an extension page; and the store-level cases (worker.ts). Needs a
// Chromium: CHROME_PATH names it. Without one it SKIPs, except under CI, where it fails: CI must run it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { done, ok } from "../check.js";
import { launch, type Browser, type Page } from "./chrome.js";

const binary = process.env.CHROME_PATH;
if (binary === undefined || binary === "") {
  if (process.env.CI !== undefined && process.env.CI !== "") { console.log("FAIL: CHROME_PATH is not set; the browser store test must run in CI"); process.exit(1); }
  console.log("SKIP: CHROME_PATH is not set; this test runs where it names a Chromium (required in CI)");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url)), pkg = join(here, "..", ".."), req = createRequire(join(pkg, "package.json"));
const esbuild = createRequire(req.resolve("tsup"))("esbuild") as { build(o: Record<string, unknown>): Promise<unknown> };
const root = mkdtempSync(join(tmpdir(), "cairnx-replica-browser-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const ext = join(root, "ext");
mkdirSync(ext);
await esbuild.build({ entryPoints: [join(here, "worker.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", outfile: join(ext, "background.js"), logLevel: "warning" });
writeFileSync(join(ext, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "cairnx-replica idbStore test", version: "1.0.0",
  background: { service_worker: "background.js", type: "module" }, permissions: ["storage", "unlimitedStorage"] }));
writeFileSync(join(ext, "ctl.html"), '<!doctype html><title>ctl</title><script src="ctl.js"></script>');
writeFileSync(join(ext, "ctl.js"), "globalThis.send = (cmd, args) => new Promise((res) => chrome.runtime.sendMessage({ cmd, args }, res));\n");

const b: Browser = await launch(binary, ext, join(root, "profile"));
const page: Page = await b.page("ctl.html");
const show = (v: unknown) => JSON.stringify(v);
try {
  console.log(`idbStore in an MV3 worker (browser pid ${b.pid}):`);
  const suite = await page.call("suite");
  ok(`the store suite over idbStore: ${suite.total} checks, ${suite.failed?.length} failed`, suite.total === 32 && suite.failed.length === 0, show(suite));
  const ref = await page.call("state", { name: "ref" });
  ok("a fill of the stub chain: every commit taken, at its top", ref.cursor === 31_860 && ref.commits.length > 20 && ref.lastError === null, show(ref));
  const cursors: number[] = ref.commits;
  const same = (s: { cursor: number; eventsHash: string; lastError: string | null }) => s.cursor === ref.cursor && s.eventsHash === ref.eventsHash && s.lastError === null;

  console.log("the production call shape across a worker stop:");
  const r1 = await page.call("reader", { name: "reader" });
  await b.stopWorker(page);
  const r2 = await page.call("reader", { name: "reader" });
  ok("open() over idbStore and sessionSlot: verified at the top, and after a worker stop opened confirmed, verified again",
    r1.verified && r2.verified && r2.cursor === 31_860 && r2.opens.join() === "ok", `${show(r1)} ${show(r2)}`);

  console.log("the worker stopped at each point of the 5th commit's writes:");
  for (const [point, at] of [["slot pair", cursors[3]], ["transaction", cursors[3]], ["slot new", cursors[4]], ["done", cursors[4]]] as const) {
    const name = `held-${point.replace(" ", "-")}`, h = await page.call("fillHeld", { name, nth: 5, point });
    await b.stopWorker(page);
    const s = await page.call("state", { name });
    ok(`stopped at "${point}": reopened confirmed at ${at}, ran on to the reference`, h.reached === point && s.opens[0] === "ok" && s.openedAt === at && same(s), show({ h, s }));
  }
  const mid = await page.call("fillHeld", { name: "held-issued", nth: 5, point: "issued" });
  await b.stopWorker(page);
  const ms = await page.call("state", { name: "held-issued" });
  ok(`stopped with the 5th commit's transaction issued: reopened confirmed at ${ms.openedAt} (the 4th or 5th commit's), ran on`,
    mid.reached === "issued" && ms.opens[0] === "ok" && [cursors[3], cursors[4]].includes(ms.openedAt) && same(ms), show({ mid, ms }));
  let confirmed = 0, empty = 0, wrong = 0;
  for (let i = 0; i < 10; i++) {
    const name = `random-${i}`;
    await page.call("fillAsync", { name });
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 1_500)));
    await b.stopWorker(page);
    const s = await page.call("state", { name });
    if (!same(s) || s.opens[0] !== "ok" || !(s.openedAt === null || cursors.includes(s.openedAt))) wrong++;
    else if (s.openedAt === null) empty++; else confirmed++;
  }
  ok(`10 stops at random times: ${confirmed} reopened confirmed at a commit's cursor, ${empty} empty, ${wrong} otherwise`, wrong === 0);

  console.log("what the slot does not name is reset and refilled:");
  await page.call("state", { name: "start" });
  await page.call("emptySlot", { name: "start" });
  await b.stopWorker(page);
  const st = await page.call("state", { name: "start" });
  ok("a browser start (the slot empty): unconfirmed, reset, refilled to the reference", st.opens.join() === "unconfirmed,ok" && st.openedAt === null && same(st), show(st));
  await page.call("state", { name: "forged" });
  const fg = await page.call("forge", { name: "forged" });
  await b.stopWorker(page);
  const fs = await page.call("state", { name: "forged" });
  ok(`a consistent forgery of the profile (a Propose added at ${fg.forgedAt}, every running value recomputed): unconfirmed, reset, refilled`,
    fs.opens.join() === "unconfirmed,ok" && fs.openedAt === null && same(fs), show(fs));
  await page.call("state", { name: "forged-control" });
  await page.call("forge", { name: "forged-control", slotToo: true });
  await b.stopWorker(page);
  const fc = await page.call("state", { name: "forged-control" });
  ok("control: the same forgery with the slot naming it opens on the forged rows", fc.opens.join() === "ok" && fc.openedAt === ref.cursor && fc.eventsHash !== ref.eventsHash, show(fc));

  console.log("the Web Lock:");
  await page.call("hold", { name: "locked" });
  const held = await page.eval(`navigator.locks.request("cairnx-replica:locked", { ifAvailable: true }, (l) => l !== null)`);
  await b.stopWorker(page);
  const freed = await page.eval(`navigator.locks.request("cairnx-replica:locked", { ifAvailable: true }, (l) => l !== null)`);
  ok("an extension page finds the worker's store locked, and takes the lock once the worker is stopped", held === false && freed === true, show({ held, freed }));
  const holder = await b.page("ctl.html");
  await holder.eval(`new Promise((ok) => navigator.locks.request("cairnx-replica:ref", () => { ok(true); return new Promise(() => {}); }))`);
  const blocked = await page.call("state", { name: "ref" });
  await holder.close();
  await new Promise((r) => setTimeout(r, 200));
  const after = await page.call("state", { name: "ref" });
  ok("while a page holds the lock the worker's open is unavailable; once the page closes it opens", blocked.opens.length > 0 && blocked.opens.every((o: string) => o === "unavailable") && after.opens.join() === "ok" && same(after),
    `${show(blocked.opens)} ${show(after.opens)}`);

  console.log("store-level cases:");
  const c = await page.call("cases");
  ok("an older genuine copy of the store restored after a commit: unconfirmed", c.olderCopy?.secondCommit === true && c.olderCopy.reopened === "unconfirmed", show(c.olderCopy));
  ok("a boundary's state hash changed in place (the record and slot untouched): corrupt; honest reopen opens", c.boundOpensFirst === "ok" && c.boundEdited === "corrupt", show([c.boundOpensFirst, c.boundEdited]));
  ok("the database deleted under an open store: the next commit is CURSOR_MOVED, the store reopens empty", c.deleted?.commit === "CURSOR_MOVED" && c.deleted.reopened === "ok", show(c.deleted));
  ok("a second store of the same name: unavailable while the first is open, opens once it is closed", show(c.twoStores) === show({ first: "ok", second: "unavailable", afterClose: "ok" }), show(c.twoStores));
  ok("a database of a later layout: reset format, deleted and made again by the reset", show(c.newer) === show({ open: "format", afterReset: "ok" }), show(c.newer));
  ok("a slot out of form: unconfirmed", c.slotOutOfForm === "unconfirmed", show(c.slotOutOfForm));
  console.log("a stolen lock (the package never steals one):");
  const sl = await page.call("steal");
  ok("stolen before A's last slot write, B commits: B's store reopens confirmed, A's commit is refused, the older snapshot opens unconfirmed",
    sl.last?.bOpen === "ok" && sl.last.bCommit === true && sl.last.aCommit === "STORE_FAILED" && sl.last.reopened === "ok" && sl.last.older === "unconfirmed", show(sl.last));
  ok("the store whose lock was stolen opens unavailable and commits nothing", sl.last?.aOpen === "unavailable" && sl.last.aAgain === false, show(sl.last));
  ok("stolen before A's first slot write: A writes no pair over B's confirmation, B's store reopens confirmed",
    sl.first?.bOpen === "ok" && sl.first.bCommit === true && sl.first.aCommit !== "ok" && sl.first.reopened === "ok", show(sl.first));
  ok("the slot changed under A before its last write: A's commit is refused and the other value stays", sl.changed?.aCommit === "STORE_FAILED" && sl.changed.slotKept === true, show(sl.changed));
  const rf = await page.call("refusals");
  ok("ReplicaConfigError for a name outside [a-z0-9-]{1,64}, a missing slot and an empty slot key", show(rf) === show({ badName: "ReplicaConfigError", noSlot: "ReplicaConfigError", emptyKey: "ReplicaConfigError" }), show(rf));
} finally {
  await b.close();
}
done("cairnx-replica idbStore in Chromium");
