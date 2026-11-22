// The counting runner of the suites moved from the private resolver's tests: t(name, fn) runs fn, which asserts with
// node:assert and returns nothing, and passCount() is how many ran. A body that returns a value is refused, since a
// bare boolean would count as a pass whatever it was.
let passed = 0;
export const passCount = (): number => passed;
export function t(name: string, fn: () => void): void {
  const r = fn() as unknown;
  if (r !== undefined) throw new Error(`test "${name}" returned a value: assert inside the body`);
  passed++;
  console.log("  ok", name);
}
