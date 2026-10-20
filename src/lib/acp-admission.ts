// Only an idempotency key + payload hash; conversation content stays in acpx.
export async function admissionId(key: string, text: string, attachments: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([text, attachments]));
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
  const storageKey = `que:admission:${key}`;
  let saved: {id?: string; fingerprint?: string} = {};
  try { saved = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch { /* invalid receipt */ }
  if (saved?.fingerprint === fingerprint && saved.id) return saved.id;
  const id = crypto.randomUUID();
  // Write before submission; reloads after a lost response retain the same key.
  sessionStorage.setItem(storageKey, JSON.stringify({id, fingerprint}));
  return id;
}
export function acknowledgeAdmission(key: string, id: string) {
  const storageKey = `que:admission:${key}`;
  try {
    if (JSON.parse(sessionStorage.getItem(storageKey) || '{}').id === id) sessionStorage.removeItem(storageKey);
  } catch { /* an invalid receipt cannot identify an accepted message */ }
}
