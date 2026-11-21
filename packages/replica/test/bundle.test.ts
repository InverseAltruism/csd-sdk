// What a page bundles from `.`, `./display` and `./browser`: each built entry is bundled by esbuild for the browser platform (the
// esbuild tsup carries, no dependency of its own), with its imports, dynamic imports and re-exports resolved under the
// browser and import conditions. A Node built-in fails the bundle; the output is then scanned for Buffer, require and
// the process global. Two controls show the checks see what they ban: an entry importing node:fs fails, and ./server,
// which reads process.env, is caught by the scan (bundled with the Node built-ins its disk store imports left out). ./display carries neither resolve() nor the block machinery, and its
// minified bundle stays under 6 KB gzip. The design's 4 KB is not reached while cairnx-core's and csd-codec's builds keep
// module-level statements a bundler cannot drop (the reason-code table, the gate table, the chain id): an entry that
// imports only NAME_RE from cairnx-core bundled minified to 2,290 bytes gzip on 2026-11-21. Run after the build.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { done, ok } from "./check.js";

type Build = (o: Record<string, unknown>) => Promise<{ outputFiles: { text: string }[] }>;
const pkg = join(dirname(fileURLToPath(import.meta.url)), ".."), req = createRequire(join(pkg, "package.json"));
const esbuild = createRequire(req.resolve("tsup"))("esbuild") as { build: Build; version: string };
const BANNED = /\bBuffer\b|\brequire\s*\(|(?<![.\w$])process\s*(?:\.|\?\.|\[)|\btypeof\s+process\b|globalThis\s*(?:\.|\?\.)\s*process\b/;

async function bundle(entry: { file: string } | { contents: string }, minify = false, external: string[] = []): Promise<{ text: string } | { error: string }> {
  try {
    const where = "file" in entry ? { entryPoints: [join(pkg, "dist", entry.file)] } : { stdin: { contents: entry.contents, resolveDir: pkg } };
    const r = await esbuild.build({ ...where, bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent", minify, external });
    return { text: r.outputFiles.map((f) => f.text).join("\n") };
  } catch (e) {
    return { error: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
  }
}

const exportsOf = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { exports: Record<string, unknown> }).exports;
ok("the package exports ./display, ./browser and ./server", "./display" in exportsOf && "./browser" in exportsOf && "./server" in exportsOf);
for (const file of ["index.js", "display.js", "browser.js"]) {
  const b = await bundle({ file }), hit = "text" in b ? BANNED.exec(b.text) : null;
  ok(`${file} bundles for the browser with esbuild ${esbuild.version} (${"text" in b ? b.text.length : 0} bytes) and names no Buffer, require or process global`,
    "text" in b && hit === null, "error" in b ? b.error : String(hit?.[0]));
}
const browser = await bundle({ file: "browser.js" });
ok("./browser carries hostedBlocks with the header window (its routes and csd-light's tryReorg are in the bundle)",
  "text" in browser && browser.text.includes("/api/blocks/") && browser.text.includes("/api/headers/") && browser.text.includes("tryReorg"));
const display = await bundle({ file: "display.js" }), small = await bundle({ file: "display.js" }, true);
const gz = "text" in small ? gzipSync(small.text).length : Number.POSITIVE_INFINITY;
ok(`./display carries neither resolve() nor the block reads, and minified is ${gz} bytes gzip, under 6,144`, gz < 6144 && "text" in display &&
  !display.text.includes("function resolve(") && !display.text.includes("/api/blocks/") && display.text.includes("/trade/api/cairnx/"));
const nodeOnly = await bundle({ contents: 'import { readFileSync } from "node:fs"; export const f = readFileSync;' });
ok("control: an entry importing node:fs does not bundle for the browser", "error" in nodeOnly);
// ./server imports Node built-ins (diskStore; the build writes them without the node: prefix), left outside its bundle
// here so that the scan runs.
const server = await bundle({ file: "server.js" }, false, ["node:*", "crypto", "fs", "fs/promises", "path"]);
ok("control: the scan finds process.env in ./server", "text" in server && BANNED.test(server.text) && server.text.includes("process.env.CAIRNX_OWN_NODE_HOSTS"));

done("cairnx-replica bundle");
