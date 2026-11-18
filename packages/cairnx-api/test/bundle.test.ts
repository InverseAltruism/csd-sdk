// What a page bundles from `.`: each built entry (ESM and CommonJS) is bundled by esbuild for the browser platform (the
// esbuild tsup carries), with its imports resolved under the browser condition. A Node built-in fails the bundle; the
// output is then scanned for Buffer, require and the process global. Two controls show the checks see what they ban.
// Run after the build.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { done, ok } from "./check.js";

type Build = (o: Record<string, unknown>) => Promise<{ outputFiles: { text: string }[] }>;
const pkg = join(dirname(fileURLToPath(import.meta.url)), ".."), req = createRequire(join(pkg, "package.json"));
const esbuild = createRequire(req.resolve("tsup"))("esbuild") as { build: Build; version: string };
const BANNED = /\bBuffer\b|\brequire\s*\(|(?<![.\w$])process\s*(?:\.|\?\.|\[)|\btypeof\s+process\b|globalThis\s*(?:\.|\?\.)\s*process\b|\bnode:/;

async function bundle(entry: { file: string } | { contents: string }, format = "esm"): Promise<{ text: string } | { error: string }> {
  try {
    const where = "file" in entry ? { entryPoints: [join(pkg, "dist", entry.file)] } : { stdin: { contents: entry.contents, resolveDir: pkg } };
    const r = await esbuild.build({ ...where, bundle: true, platform: "browser", format, write: false, logLevel: "silent" });
    return { text: r.outputFiles.map((f) => f.text).join("\n") };
  } catch (e) {
    return { error: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
  }
}

for (const file of ["index.js", "index.cjs"]) {
  const b = await bundle({ file }), hit = "text" in b ? BANNED.exec(b.text) : null;
  ok(`${file} bundles for the browser with esbuild ${esbuild.version} (${"text" in b ? b.text.length : 0} bytes) and names no Buffer, require, process or node: module`,
    "text" in b && hit === null, "error" in b ? b.error : String(hit?.[0]));
}
const nodeOnly = await bundle({ contents: 'import { readFileSync } from "node:fs"; export const f = readFileSync;' });
ok("control: an entry importing node:fs does not bundle for the browser", "error" in nodeOnly);
const usesProcess = await bundle({ contents: 'export * from "./dist/index.js"; export const e = process.env.X;' });
ok("control: the scan finds process.env beside the package", "text" in usesProcess && BANNED.test(usesProcess.text));

done("cairnx-api bundle");
