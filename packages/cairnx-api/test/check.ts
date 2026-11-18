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
/** JSON text with bigints spelled `<n>n`, for failure details. */
export const show = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));
