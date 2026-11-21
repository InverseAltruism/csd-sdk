// The kill test's child (disk-kill.test.ts): runs the sequence on the store in argv[2] and, when argv[3] names
// "<commit>:<point>[:half]", kills itself with SIGKILL at that point of that commit (a half write first puts half of
// the write's bytes). Run to the end, it prints the trace of points, the cursor meta.json names after each commit, and
// where the sequence ended.
import { readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { runSequence } from "./disk-kill-sequence.js";

const [dir, at] = process.argv.slice(2) as [string, string?];
const [commitS, name, half] = (at ?? "").split(":");
const trace: string[] = [], cursors: string[] = [];
let commit = 1;
const end = await runSequence(dir, {
  sync: false,
  point(p, write) {
    trace.push(p);
    if (String(commit) === commitS && p === name) {
      if (half === "half" && write !== undefined) {
        writeSync(write.fd, write.bytes, 0, write.bytes.length >> 1, write.position);   // where the whole write would land
      }
      process.kill(process.pid, "SIGKILL");
    }
    if (p === "done") { cursors.push(JSON.stringify(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).meta.cursor)); commit++; }
  },
});
console.log(JSON.stringify({ trace, cursors, ...end }));
