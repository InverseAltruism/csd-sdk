// A headless Chromium started by the test (its pid kept, ended by that pid), driven over the DevTools protocol on the
// debugging pipe: the test extension loaded with Extensions.loadUnpacked (which needs no --load-extension, a flag branded
// Chrome builds ignore), every host name mapped to nothing, and only a control page attached, so that DevTools does not
// keep the worker alive.
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

type Pending = { res(v: Record<string, unknown>): void; rej(e: Error): void };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Page { readonly session: string; eval(expression: string, ms?: number): Promise<unknown>; call(cmd: string, args?: Record<string, unknown>): Promise<any>; close(): Promise<void> }
export interface Browser { readonly pid: number; readonly ext: string; page(path: string): Promise<Page>; stopWorker(page: Page): Promise<void>; workers(): Promise<number>; close(): Promise<void> }

export async function launch(binary: string, extDir: string, profile: string): Promise<Browser> {
  const proc: ChildProcess = spawn(binary, ["--headless=new", "--no-sandbox", `--user-data-dir=${profile}`, "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--host-resolver-rules=MAP * ~NOTFOUND", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const pid = proc.pid!, out = proc.stdio[3] as Writable, inp = proc.stdio[4] as Readable;
  // Whatever ends the test process, the browser it started ends with it.
  const kill = () => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } };
  process.on("exit", kill);
  const exited = new Promise<void>((res) => proc.once("exit", () => res()));
  let id = 0, buf = "";
  const pending = new Map<number, Pending>();
  inp.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    for (let i = buf.indexOf("\0"); i >= 0; i = buf.indexOf("\0")) {
      const v = JSON.parse(buf.slice(0, i)) as { id?: number; result?: Record<string, unknown>; error?: unknown };
      buf = buf.slice(i + 1);
      const p = v.id === undefined ? undefined : pending.get(v.id);
      if (p === undefined) continue;
      pending.delete(v.id!);
      if (v.error !== undefined) p.rej(new Error(JSON.stringify(v.error))); else p.res(v.result ?? {});
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<Record<string, any>>((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    out.write(JSON.stringify({ id: i, method, params, sessionId }) + "\0");
  });
  const workers = async () => ((await send("Target.getTargets")).targetInfos as { type: string; url: string }[])
    .filter((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${ext}/`)).length;
  const ext = (await send("Extensions.loadUnpacked", { path: extDir })).id as string;
  for (let i = 0; i < 200 && (await workers()) === 0; i++) await sleep(25);

  async function page(path: string): Promise<Page> {
    const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${ext}/${path}` });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression: string, ms = 120_000) => {
      const r = await Promise.race([send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId),
        sleep(ms).then(() => { throw new Error(`no answer within ${ms} ms: ${expression.slice(0, 80)}`); })]);
      if (r.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result.value as unknown;
    };
    for (let i = 0; i < 200 && (await evaluate("typeof send").catch(() => "")) !== "function"; i++) await sleep(25);
    return { session: sessionId, eval: evaluate, close: async () => { await send("Target.closeTarget", { targetId }); },
      call: (cmd, args = {}) => evaluate(`send(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`) as Promise<any> };
  }
  return {
    pid, ext, page, workers,
    // Throws unless the worker is gone, so no check that needs a stop passes without one.
    async stopWorker(p) {
      await send("ServiceWorker.enable", {}, p.session);
      await send("ServiceWorker.stopAllWorkers", {}, p.session);
      for (let i = 0; i < 200 && (await workers()) > 0; i++) await sleep(10);
      if ((await workers()) > 0) throw new Error("the extension's worker did not stop");
    },
    async close() {
      await Promise.race([send("Browser.close").catch(() => undefined), sleep(5_000)]);
      if (!(await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]))) { kill(); await exited; }
      process.off("exit", kill);
    },
  };
}
