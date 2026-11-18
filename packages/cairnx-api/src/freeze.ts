/** `value`, with every object and array reachable from it frozen. A RegExp is left as it is: the patterns are
 *  cairnx-core's objects, and a non-global pattern holds no state that `test` writes. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || value instanceof RegExp || Object.isFrozen(value)) return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}
