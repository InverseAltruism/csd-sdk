/** `value`, with every object and array reachable from it frozen. A RegExp is left as it is: the patterns are
 *  cairnx-core's objects, and a non-global pattern holds no state that `test` writes. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || value instanceof RegExp || Object.isFrozen(value)) return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

/** A deep copy of plain data (objects, arrays, primitives), own enumerable keys in their order. The state and the rows
 *  are such data; a copy shares no object with its source. */
export function copyData<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(copyData) as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value)) {
    const v = copyData((value as Record<string, unknown>)[k]);
    if (k === "__proto__") Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
    else out[k] = v;
  }
  return out as T;
}
