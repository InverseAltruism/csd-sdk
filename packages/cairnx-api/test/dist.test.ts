// The built package runs: each entry the manifest's exports name (ESM and CommonJS, `.` and `./handlers`) is loaded
// from dist/ and runs prepareView over a state resolve() returns, then answer(); the answer equals the same call on
// src/. A missing dist/, or one built before the last change of src/version.ts (rev hashes the version), fails here.
// Run after the build, as the window's publish guard does.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, type CairnXState, type ChainEvent } from "@inversealtruism/cairnx-core";
import { CAIRNX_API_VERSION } from "../src/index.js";
import { answer, prepareView } from "../src/handlers/index.js";
import { done, ok } from "./check.js";
import { events, tipHeight } from "./corpus.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = createRequire(import.meta.url)(join(pkg, "package.json")) as { exports: Record<string, { import: { default: string }; require: { default: string } }> };
const source = { height: tipHeight, hash: `0x${"ab".repeat(32)}`, input: "dist", core: "0.2.10" };
const QUERY = "order=length&limit=5&after=2:zk";
const fresh = (): CairnXState => resolve(events as ChainEvent[], tipHeight);
const want = JSON.stringify(answer([prepareView(fresh(), source)], "names", QUERY));

type Root = { CAIRNX_API_VERSION?: string };
type Handlers = { prepareView?: typeof prepareView; answer?: typeof answer };
const load = async (format: "import" | "require", entry: string): Promise<unknown> => {
  const file = join(pkg, manifest.exports[entry]![format].default);
  return format === "import" ? import(pathToFileURL(file).href) : createRequire(import.meta.url)(file);
};

ok("the manifest's exports name two entries, `.` and `./handlers`", Object.keys(manifest.exports).join(" ") === ". ./handlers");
for (const format of ["import", "require"] as const) {
  let root: Root = {}, handlers: Handlers = {}, failure = "";
  try {
    root = (await load(format, ".")) as Root;
    handlers = (await load(format, "./handlers")) as Handlers;
  } catch (e) {
    failure = e instanceof Error ? e.message.split("\n")[0]! : String(e);
  }
  ok(`${format}: both entries load from dist/`, failure === "" && typeof handlers.prepareView === "function" && typeof handlers.answer === "function", failure);
  ok(`${format}: dist's CAIRNX_API_VERSION ${root.CAIRNX_API_VERSION ?? "(none)"} is src's ${CAIRNX_API_VERSION}`, root.CAIRNX_API_VERSION === CAIRNX_API_VERSION);
  const got = failure === "" && handlers.prepareView && handlers.answer
    ? JSON.stringify(handlers.answer([handlers.prepareView(fresh(), source)], "names", QUERY)) : "";
  ok(`${format}: prepareView(resolve(...)) then answer(names?${QUERY}) equals src's, byte for byte`, got === want && want.includes('"ok":true'), got.slice(0, 200));
}

done("cairnx-api dist");
