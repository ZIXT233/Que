import { useEffect, useRef, useState, useImperativeHandle, type Ref } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { audioBase64, speechRequest, startRecorder, type Recorder, type SpeechSettings as Settings } from '@/lib/speech';
import { ChatIcon } from './Icons';
import { openSettingsSection } from '@/lib/settings-navigation';
import './speech.css';

export type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';
export type SpeechInputHandle = { send: () => void };
export function SpeechInput({ active, onTranscript, onBusy, ref }: { active: boolean; onTranscript: (text: string, sendImmediately: boolean) => void; onBusy: (busy: boolean, phase: Phase) => void; ref?: Ref<SpeechInputHandle> }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('idle'), [error, setError] = useState('');
  const [levels, setLevels] = useState<number[]>(Array(64).fill(0));
  const recorder = useRef<Recorder | null>(null);
  const operation = useRef<AbortController | null>(null), phaseRef = useRef<Phase>('idle');
  const callback = useRef(onTranscript); callback.current = onTranscript;
  const busyCallback = useRef(onBusy); busyCallback.current = onBusy;
  const transition = (next: Phase) => { phaseRef.current = next; setPhase(next); busyCallback.current(next !== 'idle', next); };
  const cancel = () => { operation.current?.abort(); operation.current = null; recorder.current?.cancel(); recorder.current = null; transition('idle'); };
  useEffect(() => { if (!active) cancel(); }, [active]);
  useEffect(() => () => { operation.current?.abort(); recorder.current?.cancel(); busyCallback.current(false, 'idle'); }, []);
  const finish = async (sendImmediately = false) => {
    if (phaseRef.current !== 'recording' || !recorder.current) return;
    const controller = operation.current!;
    const wav = recorder.current.stop(); recorder.current = null;
    transition('transcribing');
    const timeout = setTimeout(() => { controller.abort(); if(operation.current === controller) { setError('speech.timeout'); transition('idle'); } }, 95_000);
    try {
      if (wav.length <= 44) throw new Error('speech.empty');
      const result = await speechRequest<{ text: string }>('transcribe', {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: audioBase64(wav) }),
      });
      if (!controller.signal.aborted) callback.current(result.text, sendImmediately);
    } catch (e) {
      if (!controller.signal.aborted) { const code = (e as Error).message; setError(code.startsWith('speech.') ? code : 'speech.network'); }
    } finally { clearTimeout(timeout); if (operation.current === controller) { operation.current = null; transition('idle'); } }
  };
  useImperativeHandle(ref, () => ({ send: () => { void finish(true); } }));
  const start = async () => {
    if (phaseRef.current !== 'idle') return;
    const controller = new AbortController(); operation.current = controller;
    setError(''); setLevels(Array(64).fill(0)); transition('starting');
    try {
      const settings = await speechRequest<Settings>('settings', { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!settings.configured) { transition('idle'); openSettingsSection('speech'); return; }
      const next = await startRecorder(controller.signal, () => void finish(), level => { if (!controller.signal.aborted) setLevels(values => [...values.slice(1), level]); });
      if (controller.signal.aborted) { next.cancel(); return; }
      recorder.current = next; transition('recording');
    } catch (e) {
      if (controller.signal.aborted) return;
      const cause = e as Error;
      setError(cause.name === 'NotAllowedError' ? 'speech.permission' : cause.name === 'NotFoundError' ? 'speech.noMicrophone' : cause.message.startsWith('speech.') ? cause.message : 'speech.recordFailed');
      transition('idle');
    }
  };
  const shortcutActions = useRef({ start, finish, cancel });
  shortcutActions.current = { start, finish, cancel };
  useEffect(() => {
    if (!active) return;
    let held = false;
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'KeyD' || !event.shiftKey || !event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.repeat || held) { event.preventDefault(); return; }
      if (phaseRef.current !== 'idle' || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault(); held = true;
      void shortcutActions.current.start();
    };
    const up = (event: KeyboardEvent) => {
      if (!held || event.code !== 'KeyD') return;
      event.preventDefault(); held = false;
      if (phaseRef.current === 'recording') void shortcutActions.current.finish();
      else if (phaseRef.current === 'starting') shortcutActions.current.cancel();
    };
    const blur = () => { if (held) { held = false; shortcutActions.current.cancel(); } };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); blur(); };
  }, [active]);
  const label = t(phase === 'recording' ? 'speech.finish' : phase === 'transcribing' ? 'speech.transcribing' : phase === 'starting' ? 'speech.starting' : 'speech.start');
  return <div className="fc-speech-input" data-phase={phase}>
    {phase !== 'idle' && <>
      <button type="button" className="fc-icon-button" aria-label={t('speech.cancel')} title={t('speech.cancel')} onClick={cancel}><ChatIcon name="close" /></button>
      <div className="fc-speech-waveform" aria-hidden="true">
        {phase === 'recording' ? levels.map((level, index) => <i key={index} style={{height: `${3 + level * 25}px`, opacity: level > 0.02 ? 0.8 : 0.3}} />) : <span className="fc-speech-state">{label}</span>}
      </div>
      <span className="sr-only" role="status">{label}</span>
    </>}
    <button type="button" className="fc-icon-button fc-microphone" data-recording={phase === 'recording'}
      aria-label={label} title={phase === 'idle' ? `${label} · ${t('speech.holdShortcut')}` : label} aria-keyshortcuts="Control+Shift+D" aria-pressed={phase === 'recording'} disabled={!active || phase === 'starting' || phase === 'transcribing'}
      onClick={() => phase === 'recording' ? void finish() : void start()}><ChatIcon name={phase === 'recording' ? 'stop' : 'microphone'} /></button>
    {error && <div className="fc-speech-error" role="alert"><span>{t(error)}</span><button type="button" className="fc-icon-button" aria-label={t('speech.dismiss')} onClick={() => setError('')}><ChatIcon name="close" /></button></div>}

  </div>;
}
