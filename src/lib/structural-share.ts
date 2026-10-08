/**
 * Return `next`, reusing every object from `previous` whose JSON content is
 * unchanged. A repeated poll then yields the identical reference, and React can
 * skip components that only received unchanged turns, tool calls or blocks.
 * Inputs must be plain parsed JSON and never mutated afterwards.
 */
export function shareStructure<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    let same = previous.length === next.length;
    const result = next.map((item, index) => {
      const shared = shareStructure(previous[index], item);
      if (shared !== previous[index]) same = false;
      return shared;
    });
    return (same ? previous : result) as T;
  }
  if (next && typeof next === 'object') {
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return next;
    const before = previous as Record<string, unknown>;
    const after = next as Record<string, unknown>;
    const keys = Object.keys(after);
    let same = keys.length === Object.keys(before).length;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const shared = shareStructure(before[key], after[key]);
      result[key] = shared;
      if (!(key in before) || shared !== before[key]) same = false;
    }
    return (same ? previous : result) as T;
  }
  return next;
}
