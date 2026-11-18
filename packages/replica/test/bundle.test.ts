// What a page bundles from `.` and `./browser`: each built entry is bundled by esbuild for the browser platform (the
// esbuild tsup carries, no dependency of its own), with its imports, dynamic imports and re-exports resolved under the
// browser and import conditions. A Node built-in fails the bundle; the output is then scanned for Buffer, require and
// the process global. Two controls show the checks see what they ban: an entry importing node:fs fails, and ./server,
// which reads process.env, is caught by the scan. Run after the build.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { done, ok } from "./check.js";

type Build = (o: Record<string, unknown>) => Promise<{ outputFiles: { text: string }[] }>;
const pkg = join(dirname(fileURLToPath(import.meta.url)), ".."), req = createRequire(join(pkg, "package.json"));
const esbuild = createRequire(req.resolve("tsup"))("esbuild") as { build: Build; version: string };
const BANNED = /\bBuffer\b|\brequire\s*\(|(?<![.\w$])process\s*(?:\.|\?\.|\[)|\btypeof\s+process\b|globalThis\s*(?:\.|\?\.)\s*process\b/;

async function bundle(entry: { file: string } | { contents: string }): Promise<{ text: string } | { error: string }> {
  try {
    const where = "file" in entry ? { entryPoints: [join(pkg, "dist", entry.file)] } : { stdin: { contents: entry.contents, resolveDir: pkg } };
    const r = await esbuild.build({ ...where, bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent" });
    return { text: r.outputFiles.map((f) => f.text).join("\n") };
  } catch (e) {
    return { error: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
  }
}

const exportsOf = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { exports: Record<string, unknown> }).exports;
ok("the package exports ./browser and ./server", "./browser" in exportsOf && "./server" in exportsOf);
for (const file of ["index.js", "browser.js"]) {
  const b = await bundle({ file }), hit = "text" in b ? BANNED.exec(b.text) : null;
  ok(`${file} bundles for the browser with esbuild ${esbuild.version} (${"text" in b ? b.text.length : 0} bytes) and names no Buffer, require or process global`,
    "text" in b && hit === null, "error" in b ? b.error : String(hit?.[0]));
}
const nodeOnly = await bundle({ contents: 'import { readFileSync } from "node:fs"; export const f = readFileSync;' });
ok("control: an entry importing node:fs does not bundle for the browser", "error" in nodeOnly);
const server = await bundle({ file: "server.js" });
ok("control: the scan finds process.env in ./server", "text" in server && BANNED.test(server.text) && server.text.includes("process.env.CAIRNX_OWN_NODE_HOSTS"));

done("cairnx-replica bundle");
