const listeners = new Set<(key: string, value: string | null) => void>();

export function observePersistentWrites(listener: (key: string, value: string | null) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Desktop storage is owned by the main process, independent of the backend port. */
export function persistentStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const desktop = (window as Window & {
    queDesktop?: { storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> };
  }).queDesktop;
  const storage = desktop?.storage ?? window.localStorage;
  return {
    getItem: key => storage.getItem(key),
    setItem: (key, value) => {
      storage.setItem(key, value);
      listeners.forEach(listener => listener(key, value));
    },
    removeItem: key => {
      storage.removeItem(key);
      listeners.forEach(listener => listener(key, null));
    },
  };
}
