import { useEffect, useRef, useState } from 'react';
import type { Message } from '../../shared/contracts';
import { api } from '../lib/api';
import { captureAnalytics } from '../lib/analytics';

export type CallPhase =
  'starting' | 'listening' | 'hearing' | 'sending' | 'thinking' | 'speaking' | 'failed';

const frameSize = 1024;
const startFrames = 3;
const interruptFrames = 5;
const preRollFrames = 6;
const silenceMs = 800;
const shortestMs = 350;
const longestMs = 60_000;
const heartbeatMs = 8_000;

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

function audioReply(message: Message) {
  return message.role === 'assistant'
    ? message.attachments.find((file) => file.mimeType.startsWith('audio/'))
    : undefined;
}

export function useVoiceCall({
  threadId,
  active,
  working,
  messages,
  send,
}: {
  threadId: string;
  active: boolean;
  working: boolean;
  messages: Message[];
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
  const queue = useRef<string[]>([]);
  const played = useRef<Set<string> | null>(null);
  const since = useRef('');
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
    queue.current = [];
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
    if (speaking.current) return;
    const url = queue.current.shift();
    if (!url) {
      idle();
      return;
    }
    const audio = new Audio(url);
    player.current = audio;
    speaking.current = true;
    show('speaking');
    const done = () => {
      if (player.current !== audio) return;
      player.current = null;
      speaking.current = false;
      playNext();
    };
    audio.onended = done;
    audio.onerror = done;
    void audio.play().catch(done);
  };

  useEffect(() => {
    if (!active) return;
    if (!played.current) {
      played.current = new Set(messages.map((message) => message.id));
      since.current = messages.reduce(
        (latest, message) => (message.createdAt > latest ? message.createdAt : latest),
        '',
      );
      return;
    }
    for (const message of messages) {
      if (played.current.has(message.id) || message.createdAt < since.current) continue;
      const audio = audioReply(message);
      if (!audio) continue;
      played.current.add(message.id);
      queue.current.push(audio.url);
    }
    playNext();
  }, [active, messages]);

  useEffect(() => {
    if (active) idle();
  }, [active, working]);

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
          context = new AudioContext({ sampleRate: 16_000 });
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
        let loud = 0;
        let quietMs = 0;
        let spokenMs = 0;
        let capturing = false;
        let chunks: Float32Array[] = [];
        const recent: Float32Array[] = [];
        let shown = 0;
        const finish = () => {
          capturing = false;
          const captured = chunks;
          const duration = spokenMs;
          chunks = [];
          spokenMs = 0;
          quietMs = 0;
          if (phaseRef.current === 'hearing') phaseRef.current = 'listening';
          if (duration < shortestMs) {
            idle();
            return;
          }
          sending.current++;
          show('sending');
          void sendRef
            .current(waveFile(captured, rate))
            .then((delivered) => {
              if (delivered) sent++;
            })
            .catch(() => {})
            .finally(() => {
              sending.current--;
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
            loud = 0;
            return;
          }
          const threshold = speaking.current
            ? Math.max(0.05, noise * 6)
            : Math.max(0.015, noise * 3);
          const voiced = rms > threshold;
          if (!capturing) {
            if (!voiced) noise = noise * 0.95 + Math.min(rms, 0.05) * 0.05;
            recent.push(samples);
            if (recent.length > preRollFrames) recent.shift();
            loud = voiced ? loud + 1 : 0;
            if (loud < (speaking.current ? interruptFrames : startFrames)) return;
            if (speaking.current) stopSpeaking();
            capturing = true;
            chunks = [...recent];
            recent.length = 0;
            spokenMs = loud * frameMs;
            quietMs = 0;
            loud = 0;
            show('hearing');
            return;
          }
          chunks.push(samples);
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
      if (processor) processor.onaudioprocess = null;
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context?.close().catch(() => {});
      played.current = null;
    };
  }, [active, threadId]);

  const interrupt = () => {
    stopSpeaking();
    idle();
  };
  return { phase, error, muted, setMuted, level, interrupt };
}
