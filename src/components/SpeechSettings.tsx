import { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { speechRequest, type SpeechSettings as Settings } from '@/lib/speech';
import { ConfigButton, CONFIG_INPUT_STYLE } from './SettingsUi';

export function SpeechSettings({ onSaved }: { onSaved?: () => void }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Settings>();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void speechRequest<Settings>('settings', { signal: controller.signal }).then(setSettings).catch(() => {
      if (!controller.signal.aborted) setMessage('speech.network');
    });
    return () => controller.abort();
  }, []);
  const save = async (remove = false) => {
    if (!settings) return;
    setBusy(true); setMessage('');
    try {
      const next = await speechRequest<Settings>('settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: settings.language, ...(remove ? { apiKey: '' } : key.trim() ? { apiKey: key.trim() } : {}) }) });
      setSettings(next); setKey(''); setMessage('speech.saved'); onSaved?.();
    } catch (error) { const code = (error as Error).message; setMessage(code.startsWith('speech.') ? code : 'speech.network'); }
    finally { setBusy(false); }
  };
  return <div className="fc-speech-settings">
    <p>{t('speech.settingsHint')}</p>
    <label><span>MiMo API Key</span><input type="password" autoComplete="new-password" spellCheck={false} style={CONFIG_INPUT_STYLE}
      value={key} disabled={busy || !settings} placeholder={t(settings?.configured ? 'speech.keySaved' : 'speech.keyPlaceholder')}
      onChange={event => setKey(event.target.value)} /></label>
    <div className="fc-speech-languages" role="group" aria-label={t('speech.language')}>
      {(['auto', 'zh', 'en'] as const).map(language => <button key={language} type="button" disabled={busy || !settings}
        aria-pressed={settings?.language === language} onClick={() => { setSettings(s => s && ({ ...s, language })); setMessage(''); }}>{t(`speech.${language}`)}</button>)}
    </div>
    <div className="fc-speech-settings-actions">
      <ConfigButton disabled={busy || !settings || (!settings.configured && !key.trim())} onClick={() => void save()}>{t('speech.save')}</ConfigButton>
      {settings?.configured && <ConfigButton variant="ghost" disabled={busy} onClick={() => void save(true)}>{t('speech.removeKey')}</ConfigButton>}
    </div>
    {message && <p role="status">{t(message)}</p>}
  </div>;
}
