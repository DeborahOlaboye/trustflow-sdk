/**
 * Returns `prev` wherever `next` is deeply equal to it, so unchanged data keeps
 * its object identity across polls. Arrays and plain objects are compared
 * member by member: an array whose elements all match returns the previous
 * array, and when only some elements change the unchanged elements are reused
 * inside a new array. Anything else (class instances, Maps, Dates) is
 * compared with `Object.is`.
 *
 * This is what lets a `React.memo` child that receives polled data skip
 * re-rendering when a poll returns the same values (#784).
 */
export function replaceEqualDeep<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;

  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    const merged = next.map((item, i) => {
      const shared = i < prev.length ? replaceEqualDeep(prev[i], item) : item;
      if (!Object.is(shared, prev[i])) same = false;
      return shared;
    });
    return (same ? prev : merged) as T;
  }

  if (isPlainObject(prev) && isPlainObject(next)) {
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    let same = prevKeys.length === nextKeys.length;
    const merged: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const shared = replaceEqualDeep(prev[key], next[key]);
      if (!Object.is(shared, prev[key]) || !(key in prev)) same = false;
      merged[key] = shared;
    }
    return (same ? prev : merged) as T;
  }

  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
