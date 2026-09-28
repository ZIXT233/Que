import catalog from '../../resources/settings-catalog.json';
import { observePersistentWrites, persistentStorage } from './persistent-storage';
import { announceQueueToast } from './queue-toast';
import { resolveBrowserLocale } from './i18n/registry';

const fields = Object.entries(catalog);
const byStorage = new Map(fields.map(([name, field]) => [field.storageKey, { name, ...field }]));
type PreferenceSchema = {
  type: string;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
  properties?: Record<string, PreferenceSchema>;
};

function validPreference(value: unknown, schema: PreferenceSchema): boolean {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entries = Object.entries(value), properties = schema.properties ?? {};
    return entries.length === Object.keys(properties).length
      && entries.every(([key, item]) => !!properties[key] && validPreference(item, properties[key]));
  }
  if (typeof value !== schema.type) return false;
  if (typeof value === 'number' && (!Number.isInteger(value)
    || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return !schema.enum || schema.enum.includes(value);
}

export function decodePreference(key: string, raw: string | null): unknown {
  const field = byStorage.get(key);
  if (!field || raw === null) return undefined;
  try {
    const value = field.type === 'string' ? raw : JSON.parse(raw);
    return validPreference(value, field) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function startSettingsSync() {
  let applying = false, pending = 0, epoch = 0, readVersion = 0, initialized = false;
  let serial = Promise.resolve();

  const apply = (values: Record<string, unknown>) => {
    applying = true;
    try {
      for (const [name, field] of fields) {
        if (!(name in values)) continue;
        const text = field.type === 'string' ? String(values[name]) : JSON.stringify(values[name]);
        const old = persistentStorage().getItem(field.storageKey);
        if (old === text) continue;
        persistentStorage().setItem(field.storageKey, text);
        window.dispatchEvent(new StorageEvent('storage', {
          key: field.storageKey, oldValue: old, newValue: text,
        }));
      }
    } finally {
      applying = false;
    }
  };

  const request = async (body?: unknown) => {
    const response = await fetch('/api/preferences', {
      ...(body ? {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      } : {}),
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '设置保存失败');
    return data;
  };

  const initialValues = () => {
    const initial: Record<string, unknown> = Object.fromEntries(fields.map(([name, field]) => [name, field.default]));
    initial.language = resolveBrowserLocale(window.navigator.languages.length
      ? [...window.navigator.languages] : [window.navigator.language]);
    for (const [name, field] of fields) {
      const value = decodePreference(field.storageKey, persistentStorage().getItem(field.storageKey));
      if (value !== undefined) initial[name] = value;
    }
    return initial;
  };

  // Retry initialization after a backend restart. Read current local values on
  // each attempt, and fill only missing fields so MCP edits always survive.
  const sync = async () => {
    if (pending) return;
    const started = epoch, version = ++readVersion;
    try {
      const values = await request(initialized ? undefined : { patch: initialValues(), onlyMissing: true });
      initialized = true;
      if (!pending && started === epoch && version === readVersion) apply(values);
    } catch {
      // Keep the UI usable during a backend restart.
    }
  };

  const stop = observePersistentWrites((key, raw) => {
    if (applying) return;
    const field = byStorage.get(key);
    if (!field) return;
    const value = raw === null ? field.default : decodePreference(key, raw);
    if (value === undefined) return;
    epoch++;
    pending++;
    serial = serial.then(async () => {
      try {
        await request({ patch: { [field.name]: value } });
      } catch {
        announceQueueToast('设置未能保存，请检查连接后重试');
      } finally {
        pending--;
        if (!pending) await sync();
      }
    });
  });

  await sync();
  const timer = setInterval(() => void sync(), 1500);
  window.addEventListener('focus', sync);
  return () => {
    stop();
    clearInterval(timer);
    window.removeEventListener('focus', sync);
  };
}
