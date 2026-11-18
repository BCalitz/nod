import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { captureAnalytics } from '../lib/analytics';

export type CallPhase =
  'starting' | 'listening' | 'hearing' | 'sending' | 'thinking' | 'speaking' | 'failed';

const frameSize = 1024;
const startFrames = 3;
const startWindow = 5;
const interruptFrames = 5;
const interruptWindow = 8;
const preRollFrames = 6;
const silenceMs = 1100;
const shortestMs = 350;
const longestMs = 60_000;
const heartbeatMs = 8_000;
const liveRate = 24_000;
const liveFlushMs = 200;

export const liveRecordings = new WeakMap<File, string>();

function resampler(from: number) {
  if (from === liveRate) return (input: Float32Array) => input;
  const step = from / liveRate;
  let carry = new Float32Array(0);
  let position = 0;
  return (input: Float32Array) => {
    const samples = new Float32Array(carry.length + input.length);
    samples.set(carry);
    samples.set(input, carry.length);
    const output: number[] = [];
    while (position + 1 < samples.length) {
      const index = Math.floor(position);
      const fraction = position - index;
      output.push(samples[index] * (1 - fraction) + samples[index + 1] * fraction);
      position += step;
    }
    const kept = Math.floor(position);
    carry = samples.slice(kept);
    position -= kept;
    return Float32Array.from(output);
  };
}

function pcmBase64(chunks: Float32Array[]) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(length * 2);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const chunk of chunks)
    for (const sample of chunk) {
      const value = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += 2;
    }
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

function liveListener(threadId: string, rate: number) {
  const convert = resampler(rate);
  let pending: Float32Array[] = [];
  let id: string | undefined;
  let failed = false;
  let posting = Promise.resolve();
  const opened = api<{ id: string }>('/api/call/listen', {
    method: 'POST',
    body: JSON.stringify({ threadId }),
  })
    .then((result) => {
      id = result.id;
    })
    .catch(() => {
      failed = true;
    });
  const flush = () => {
    if (!id || failed || !pending.length) return;
    const audio = pcmBase64(pending);
    pending = [];
    const target = id;
    posting = posting.then(() =>
      api(`/api/call/listen/${target}`, { method: 'POST', body: JSON.stringify({ audio }) })
        .then(() => {})
        .catch(() => {
          failed = true;
        }),
    );
  };
  const timer = window.setInterval(flush, liveFlushMs);
  const close = () => {
    window.clearInterval(timer);
    failed = true;
    void opened.then(() => {
      if (id) void api(`/api/call/listen/${id}`, { method: 'DELETE' }).catch(() => {});
    });
  };
  return {
    push(samples: Float32Array) {
      if (!failed) pending.push(convert(samples));
    },
    async end() {
      window.clearInterval(timer);
      await opened;
      flush();
      await posting;
      if (failed) {
        close();
        return undefined;
      }
      return id;
    },
    cancel: close,
  };
}

function savedMicrophone() {
  try {
    return localStorage.getItem('nod.microphone') ?? '';
  } catch {
    return '';
  }
}

function waveFile(chunks: Float32Array[], rate: number) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new ArrayBuffer(44 + length * 2);
  const view = new DataView(bytes);
  const label = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  label(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  label(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks)
    for (const sample of chunk) {
      const value = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += 2;
    }
  return new File([bytes], 'Voice message.wav', { type: 'audio/wav' });
}

function microphoneError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      return 'Allow microphone access in your browser or system settings, then start the call again.';
    if (error.name === 'NotFoundError') return 'Connect a microphone, then start the call again.';
    if (error.name === 'NotReadableError')
      return 'Your microphone is unavailable. Check that another app is not using it, then start the call again.';
  }
  return 'The call could not start. Check your microphone and try again.';
}

function messageBucket(count: number) {
  return count === 0 ? '0' : count === 1 ? '1' : count <= 5 ? '2-5' : '6+';
}

function durationBucket(ms: number) {
  return ms < 60_000 ? 'under_1m' : ms < 300_000 ? '1_5m' : '5m_plus';
}

type Clip = { url: string; streamId: string };

export function useVoiceCall({
  threadId,
  active,
  working,
  streams,
  send,
}: {
  threadId: string;
  active: boolean;
  working: boolean;
  streams: string[];
  send(recording: File): Promise<boolean>;
}) {
  const [phase, setPhase] = useState<CallPhase>('starting');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const mutedRef = useRef(false);
  mutedRef.current = muted;
  const workingRef = useRef(working);
  workingRef.current = working;
  const sendRef = useRef(send);
  sendRef.current = send;
  const streamsRef = useRef(streams);
  streamsRef.current = streams;
  const queue = useRef<Clip[]>([]);
  const held = useRef<Clip[]>([]);
  const heard = useRef<string[]>([]);
  const holds = useRef(0);
  const silenced = useRef(new Set<string>());
  const playing = useRef<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const speaking = useRef(false);
  const sending = useRef(0);
  const phaseRef = useRef<CallPhase>('starting');
  const show = (next: CallPhase) => {
    phaseRef.current = next;
    setPhase(next);
  };
  const idle = () => {
    if (phaseRef.current === 'failed' || phaseRef.current === 'hearing') return;
    show(
      speaking.current
        ? 'speaking'
        : sending.current
          ? 'sending'
          : workingRef.current
            ? 'thinking'
            : 'listening',
    );
  };

  const stopSpeaking = () => {
    for (const streamId of [playing.current, ...queue.current.map((item) => item.streamId)])
      if (streamId) silenced.current.add(streamId);
    queue.current = [];
    playing.current = null;
    const current = player.current;
    player.current = null;
    speaking.current = false;
    if (current) {
      current.onended = null;
      current.onerror = null;
      current.pause();
      current.removeAttribute('src');
      current.load();
    }
  };

  const playNext = () => {
    if (speaking.current || holds.current) return;
    const next = queue.current.shift();
    if (!next) {
      idle();
      return;
    }
    playing.current = next.streamId;
    const audio = new Audio(next.url);
    player.current = audio;
    speaking.current = true;
    show('speaking');
    const done = () => {
      if (player.current !== audio) return;
      player.current = null;
      playing.current = null;
      speaking.current = false;
      playNext();
    };
    audio.onended = done;
    audio.onerror = done;
    void audio.play().catch(done);
  };

  const hold = () => {
    holds.current++;
    player.current?.pause();
    heard.current = [
      ...new Set([
        ...heard.current,
        ...streamsRef.current,
        ...(playing.current ? [playing.current] : []),
        ...queue.current.map((item) => item.streamId),
      ]),
    ];
  };

  const release = (spoke: boolean) => {
    holds.current = Math.max(0, holds.current - 1);
    if (holds.current) return;
    const waiting = held.current;
    held.current = [];
    if (spoke) {
      for (const streamId of heard.current) silenced.current.add(streamId);
      for (const item of waiting) silenced.current.add(item.streamId);
      heard.current = [];
      stopSpeaking();
      playNext();
      return;
    }
    heard.current = [];
    queue.current.push(...waiting);
    if (player.current) void player.current.play().catch(() => {});
    else playNext();
  };

  useEffect(() => {
    if (active) idle();
  }, [active, working]);

  useEffect(() => {
    if (!active) return;
    const clip = (event: Event) => {
      const { id, streamId } = (event as CustomEvent<{ id: string; streamId: string }>).detail;
      if (silenced.current.has(streamId)) return;
      const item = { url: `/api/call/audio/${encodeURIComponent(id)}`, streamId };
      if (holds.current) held.current.push(item);
      else {
        queue.current.push(item);
        playNext();
      }
    };
    window.addEventListener('nod:call-audio', clip);
    return () => window.removeEventListener('nod:call-audio', clip);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let closed = false;
    const callId = crypto.randomUUID();
    const beat = (state: boolean) =>
      api('/api/call', {
        method: 'POST',
        body: JSON.stringify({ threadId, callId, active: state }),
        keepalive: !state,
      }).catch(() => {});
    void beat(true);
    const heartbeat = window.setInterval(() => void beat(true), heartbeatMs);
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let processor: ScriptProcessorNode | undefined;
    let started = 0;
    let sent = 0;
    let listener: ReturnType<typeof liveListener> | undefined;
    (async () => {
      try {
        const deviceId = savedMicrophone();
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
          },
        });
        if (closed) return;
        let source: MediaStreamAudioSourceNode;
        try {
          context = new AudioContext({ sampleRate: liveRate });
          source = context.createMediaStreamSource(stream);
        } catch {
          void context?.close().catch(() => {});
          context = new AudioContext();
          source = context.createMediaStreamSource(stream);
        }
        await context.resume();
        if (closed) return;
        const rate = context.sampleRate;
        const frameMs = (frameSize / rate) * 1000;
        processor = context.createScriptProcessor(frameSize, 1, 1);
        const silent = context.createGain();
        silent.gain.value = 0;
        source.connect(processor);
        processor.connect(silent);
        silent.connect(context.destination);
        let noise = 0.01;
        let history: boolean[] = [];
        let quietMs = 0;
        let spokenMs = 0;
        let capturing = false;
        let chunks: Float32Array[] = [];
        const recent: Float32Array[] = [];
        let shown = 0;
        const finish = () => {
          capturing = false;
          const live = listener;
          listener = undefined;
          const captured = chunks;
          const duration = spokenMs;
          chunks = [];
          spokenMs = 0;
          quietMs = 0;
          if (phaseRef.current === 'hearing') phaseRef.current = 'listening';
          if (duration < shortestMs) {
            live?.cancel();
            release(false);
            idle();
            return;
          }
          sending.current++;
          show('sending');
          void (live?.end() ?? Promise.resolve(undefined))
            .then((listenId) => {
              const recording = waveFile(captured, rate);
              if (listenId) liveRecordings.set(recording, listenId);
              return sendRef.current(recording);
            })
            .then((delivered) => {
              if (delivered) sent++;
            })
            .catch(() => {})
            .finally(() => {
              sending.current--;
              release(true);
              idle();
            });
        };
        processor.onaudioprocess = (event) => {
          const samples = new Float32Array(event.inputBuffer.getChannelData(0));
          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          const rms = Math.sqrt(sum / samples.length);
          const now = performance.now();
          if (now - shown > 100) {
            shown = now;
            setLevel(Math.min(1, rms * 12));
          }
          if (mutedRef.current) {
            if (capturing) finish();
            history = [];
            return;
          }
          const threshold =
            speaking.current && !holds.current
              ? Math.max(0.03, noise * 4)
              : Math.max(0.015, noise * 3);
          const voiced = rms > threshold;
          if (!capturing) {
            if (!voiced) noise = noise * 0.95 + Math.min(rms, 0.05) * 0.05;
            recent.push(samples);
            if (recent.length > preRollFrames) recent.shift();
            history = [...history, voiced].slice(-interruptWindow);
            const interrupting = speaking.current && !holds.current;
            const loud = history
              .slice(-(interrupting ? interruptWindow : startWindow))
              .filter(Boolean).length;
            if (loud < (interrupting ? interruptFrames : startFrames)) return;
            hold();
            capturing = true;
            listener = liveListener(threadId, rate);
            for (const chunk of recent) listener.push(chunk);
            chunks = [...recent];
            recent.length = 0;
            spokenMs = loud * frameMs;
            quietMs = 0;
            history = [];
            show('hearing');
            return;
          }
          chunks.push(samples);
          listener?.push(samples);
          spokenMs += frameMs;
          quietMs = voiced ? 0 : quietMs + frameMs;
          if (quietMs >= silenceMs || spokenMs >= longestMs) finish();
        };
        started = Date.now();
        captureAnalytics('voice_call_started');
        idle();
      } catch (cause) {
        if (closed) return;
        captureAnalytics('voice_call_ended', {
          outcome: 'microphone_failed',
          messages: '0',
          duration: 'under_1m',
        });
        setError(microphoneError(cause));
        show('failed');
      }
    })();
    return () => {
      closed = true;
      if (started)
        captureAnalytics('voice_call_ended', {
          outcome: 'ended',
          messages: messageBucket(sent),
          duration: durationBucket(Date.now() - started),
        });
      window.clearInterval(heartbeat);
      void beat(false);
      stopSpeaking();
      listener?.cancel();
      if (processor) processor.onaudioprocess = null;
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context?.close().catch(() => {});
      holds.current = 0;
      held.current = [];
      heard.current = [];
    };
  }, [active, threadId]);

  const interrupt = () => {
    stopSpeaking();
    idle();
  };
  return { phase, error, muted, setMuted, level, interrupt };
}
