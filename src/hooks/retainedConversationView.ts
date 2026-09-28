import { useMemo, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';

// A card can move between the deck and the inspection view during a send.
// Keep its presentation state in this WebView, not in a second history database.
export function createRetainedConversationView<T extends object>(
  initial: (key: string) => T,
  pending: (value: T) => boolean,
) {
  const entries = new Map<string, ReturnType<typeof createEntry>>();
  function prune() {
    for (const [key, entry] of entries) {
      if (entries.size <= 24) break;
      if (!entry.listeners.size && !pending(entry.get())) entries.delete(key);
    }
  }
  function createEntry(key: string) {
    let value = initial(key);
    const listeners = new Set<() => void>();
    const setters = new Map<keyof T, Dispatch<SetStateAction<any>>>();
    return {
      listeners,
      get: () => value,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); prune(); };
      },
      setter<K extends keyof T>(field: K): Dispatch<SetStateAction<T[K]>> {
        if (!setters.has(field)) setters.set(field, next => {
          const updated = typeof next === 'function' ? next(value[field]) : next;
          if (Object.is(value[field], updated)) return;
          value = { ...value, [field]: updated };
          listeners.forEach(listener => listener());
        });
        return setters.get(field)!;
      },
    };
  }
  return function useRetainedConversationView(key: string) {
    const entry = useMemo(() => {
      const found = entries.get(key) || createEntry(key);
      // Refresh insertion order, so unmounted recent cards survive navigation.
      entries.delete(key);
      entries.set(key, found);
      return found;
    }, [key]);
    const value = useSyncExternalStore(entry.subscribe, entry.get);
    return {
      field<K extends keyof T>(field: K): [T[K], Dispatch<SetStateAction<T[K]>>] {
        return [value[field], entry.setter(field)];
      },
      value,
    };
  };
}
