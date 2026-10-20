export type SpeechSettings = { configured: boolean; language: 'auto' | 'zh' | 'en' };
export async function speechRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/speech/${path}`, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'speech.network');
  return data;
}
export function encodeWav(chunks: Float32Array[], sampleRate: number): Uint8Array {
  const count = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + count * 2), view = new DataView(buffer);
  const tag = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const value of chunk) {
    const sample = Math.max(-1, Math.min(1, value));
    view.setInt16(offset, sample * (sample < 0 ? 32768 : 32767), true); offset += 2;
  }
  return new Uint8Array(buffer);
}
export function audioBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function appendTranscript(draft: string, text: string): string {
  const separator = /[A-Za-z0-9.,!?;:]$/.test(draft) && /^[A-Za-z0-9]/.test(text) ? ' ' : '';
  return draft + separator + text;
}
export type Recorder = { stop: () => Uint8Array; cancel: () => void };
export async function startRecorder(signal: AbortSignal, onLimit: () => void, onLevel?: (level: number) => void): Promise<Recorder> {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) throw new Error('speech.unsupported');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  if (signal.aborted) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('Cancelled', 'AbortError'); }
  let context: AudioContext | undefined, source: MediaStreamAudioSourceNode | undefined, node: AudioWorkletNode | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false, chunks: Float32Array[] = [], count = 0;
  const cleanup = () => {
    if (ended) return;
    ended = true; clearTimeout(timer); signal.removeEventListener('abort', cleanup);
    if (node) node.port.onmessage = null;
    source?.disconnect(); node?.disconnect(); stream.getTracks().forEach(track => track.stop());
    if (context) void context.close().catch(() => {});
  };
  signal.addEventListener('abort', cleanup, { once: true });
  try {
    context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule('/que-pcm-recorder.js');
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    source = context.createMediaStreamSource(stream); node = new AudioWorkletNode(context, 'que-pcm-recorder');
    const maxSamples = Math.min(context.sampleRate * 120, 3_500_000);
    let levelSamples = 0, levelEnergy = 0, smoothedLevel = 0;
    node.port.onmessage = event => {
      if (ended) return;
      const chunk = (event.data as Float32Array).slice(0, maxSamples - count);
      chunks.push(chunk); count += chunk.length;
      for (const value of chunk) levelEnergy += value * value;
      levelSamples += chunk.length;
      if (levelSamples >= context!.sampleRate * 0.18) {
        const level = Math.min(1, Math.sqrt(levelEnergy / levelSamples) * 5);
        smoothedLevel += (level - smoothedLevel) * 0.55;
        onLevel?.(smoothedLevel);
        levelSamples = 0; levelEnergy = 0;
      }
      if (count >= maxSamples) onLimit();
    };
    source.connect(node); node.connect(context.destination); // Worklet emits silence, never microphone feedback.
    await context.resume();
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    timer = setTimeout(onLimit, 120_000);
    return {
      stop: () => { cleanup(); const wav = encodeWav(chunks, context!.sampleRate); chunks = []; return wav; },
      cancel: () => { cleanup(); chunks = []; },
    };
  } catch (error) { cleanup(); throw error; }
}
