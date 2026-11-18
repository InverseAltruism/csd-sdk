// The check every test file of this package counts with; done() prints the counts and fails the process on any failure.
let pass = 0, fail = 0;
export function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || detail === "" ? "" : `\n       ${detail}`}`);
}
export function done(what: string): void {
  console.log(`\n${what}: ${pass} passed, ${fail} failed`);
  if (fail > 0 || pass === 0) process.exit(1);
}
/** The error `fn` throws, or null. */
export function thrown(fn: () => unknown): unknown {
  try { fn(); return null; } catch (e) { return e; }
}
