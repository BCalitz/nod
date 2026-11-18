import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GeneratedAudio, LiveTranscription } from '../ports/speech.ts';
import type { ProviderUsageEvent } from '../ports/provider-usage.ts';
import { SpeechProviderError } from '../ports/speech.ts';
import type { SpeechService } from './speech.ts';
import { callAudio } from './events.ts';

const heartbeatMs = 20_000;
const clipMs = 120_000;
const clipLimit = 64;
const calls = new Map<string, Map<string, number>>();
type Clip = {
  owner: string;
  mimeType?: string;
  chunks: Buffer[];
  done: boolean;
  expires: number;
  waiting: Set<() => void>;
};
const clips = new Map<string, Clip>();
const listenMs = 90_000;
const listenLimit = 8;
const listenBytes = 24_000 * 2 * 65;
type Listening = {
  owner: string;
  chunks: Buffer[];
  size: number;
  expires: number;
  live: Promise<LiveTranscription | undefined>;
  usage: ProviderUsageEvent[];
  heard?: Promise<{ text: string; usage: ProviderUsageEvent[] }>;
};
const listens = new Map<string, Listening>();

function dropListen(id: string) {
  const session = listens.get(id);
  if (!session) return;
  listens.delete(id);
  if (!session.heard) void session.live.then((live) => live?.close());
}

function sweepListens() {
  const now = Date.now();
  for (const [id, session] of listens) if (session.expires <= now) dropListen(id);
  while (listens.size >= listenLimit) dropListen(listens.keys().next().value!);
}

function waveFile(chunks: Buffer[], size: number) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + size, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(size, 40);
  return Buffer.concat([header, ...chunks]);
}

export async function heardOnCall(
  id: string,
  owner: string,
  speech: Pick<SpeechService, 'transcribe'>,
  signal: AbortSignal,
  report: (usage: ProviderUsageEvent) => void,
) {
  const session = listens.get(id);
  if (!session || session.owner !== owner || session.expires <= Date.now())
    throw Object.assign(
      new SpeechProviderError('This part of the call is no longer available. Say it again.'),
      { statusCode: 409, retryable: false },
    );
  session.expires = Date.now() + listenMs;
  session.heard ??= (async () => {
    const live = await session.live;
    if (live)
      try {
        const text = (
          await live.finish(AbortSignal.any([signal, AbortSignal.timeout(8_000)]))
        ).trim();
        if (text) return { text, usage: session.usage };
      } catch {
        signal.throwIfAborted();
      }
    const usage: ProviderUsageEvent[] = [...session.usage];
    const text = await speech.transcribe(
      { bytes: waveFile(session.chunks, session.size), mimeType: 'audio/wav', name: 'call.wav' },
      signal,
      (event) => usage.push(event),
    );
    return { text, usage };
  })();
  try {
    const result = await session.heard;
    for (const usage of result.usage) report(usage);
    return result.text;
  } catch (error) {
    session.heard = undefined;
    throw error;
  }
}

export function inCall(threadId: string) {
  const clients = calls.get(threadId);
  if (!clients) return false;
  const now = Date.now();
  for (const [client, until] of clients) if (until <= now) clients.delete(client);
  if (clients.size) return true;
  calls.delete(threadId);
  return false;
}

export function setCall(threadId: string, callId: string, active: boolean) {
  const clients = calls.get(threadId) ?? new Map<string, number>();
  if (active) clients.set(callId, Date.now() + heartbeatMs);
  else clients.delete(callId);
  if (clients.size) calls.set(threadId, clients);
  else calls.delete(threadId);
}

export function speakable(text: string) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, '')
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/(\*\*|__|`)(.*?)\1/g, '$2')
    .trim();
}

function openClip(owner: string) {
  const now = Date.now();
  for (const [id, clip] of clips) if (clip.expires <= now) clips.delete(id);
  while (clips.size >= clipLimit) clips.delete(clips.keys().next().value!);
  const id = randomUUID();
  const clip: Clip = { owner, chunks: [], done: false, expires: now + clipMs, waiting: new Set() };
  clips.set(id, clip);
  return { id, clip };
}

function changed(clip: Clip) {
  for (const wake of clip.waiting) wake();
  clip.waiting.clear();
}

function append(clip: Clip, chunk: Buffer, mimeType: string) {
  if (clip.done || !chunk.length) return;
  clip.mimeType ??= mimeType;
  clip.chunks.push(chunk);
  changed(clip);
}

function close(clip: Clip) {
  clip.done = true;
  changed(clip);
}

const next = (clip: Clip) => new Promise<void>((resolve) => clip.waiting.add(resolve));

type CallTarget = { ownerId: string; threadId: string; turnId: string };

function announce(target: CallTarget, streamId: string, sequence: number, id: string) {
  if (!inCall(target.threadId)) return;
  callAudio({
    ownerId: target.ownerId,
    threadId: target.threadId,
    turnId: target.turnId,
    streamId,
    id,
    sequence,
  });
}

export function playOnCall(
  input: CallTarget & { streamId: string; sequence: number; audio: GeneratedAudio },
) {
  if (!inCall(input.threadId)) return;
  const { id, clip } = openClip(input.ownerId);
  append(clip, input.audio.bytes, input.audio.mimeType);
  close(clip);
  announce(input, input.streamId, input.sequence, id);
}

export function callSpeaker(input: {
  ownerId: string;
  threadId: string;
  turnId: string;
  signal: AbortSignal;
  synthesize(
    text: string,
    stream: (chunk: Buffer, mimeType: string) => void,
  ): Promise<GeneratedAudio>;
  failed(error: unknown): void;
}) {
  const pending = new Map<string, string>();
  const voiced = new Set<string>();
  let sequence = 0;
  let order = Promise.resolve();
  const work: Promise<void>[] = [];
  const speak = (text: string, streamId: string) => {
    const clean = speakable(text).slice(0, 4096);
    if (!clean || input.signal.aborted) return;
    voiced.add(streamId);
    const index = sequence++;
    const { id, clip } = openClip(input.ownerId);
    work.push(
      input
        .synthesize(clean, (chunk, mimeType) => append(clip, chunk, mimeType))
        .then(
          (result) => {
            if (!clip.chunks.length) append(clip, result.bytes, result.mimeType);
          },
          (error) => {
            if (!input.signal.aborted) input.failed(error);
          },
        )
        .finally(() => close(clip)),
    );
    order = order.then(async () => {
      while (!clip.mimeType && !clip.done) await next(clip);
      if (input.signal.aborted || !clip.chunks.length) return;
      announce(input, streamId, index, id);
    });
  };
  return {
    push(text: string, streamId: string, done = false) {
      const buffered = (pending.get(streamId) ?? '') + text;
      if (done) {
        pending.delete(streamId);
        speak(buffered, streamId);
        return;
      }
      const boundary = Math.max(
        buffered.lastIndexOf('\n'),
        ...[...buffered.matchAll(/[.!?]["')\]]*(?=\s|$)/g)].map(
          (match) => match.index + match[0].length,
        ),
      );
      if (boundary > 0 && (sequence === 0 || boundary >= 80)) {
        speak(buffered.slice(0, boundary), streamId);
        pending.set(streamId, buffered.slice(boundary));
      } else pending.set(streamId, buffered);
    },
    finish(streamId?: string) {
      for (const [id, text] of pending) speak(text, id);
      pending.clear();
      return Boolean(streamId && voiced.has(streamId));
    },
    async finished() {
      await Promise.all([order, ...work]);
    },
  };
}

export function registerCalls(
  app: FastifyInstance,
  ownerId: string,
  speech?: Pick<SpeechService, 'listen'>,
) {
  app.post('/api/call/listen', async (request) => {
    const input = z.object({ threadId: z.uuid() }).strict().parse(request.body);
    if (!inCall(input.threadId))
      throw Object.assign(new Error('Start the call again before speaking.'), {
        statusCode: 409,
      });
    sweepListens();
    const id = randomUUID();
    const usage: ProviderUsageEvent[] = [];
    listens.set(id, {
      owner: ownerId,
      chunks: [],
      size: 0,
      expires: Date.now() + listenMs,
      usage,
      live: (speech?.listen((event) => usage.push(event)) ?? Promise.resolve(undefined)).catch(
        () => undefined,
      ),
    });
    return { id };
  });
  app.post<{ Params: { id: string } }>('/api/call/listen/:id', async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { audio } = z
      .object({ audio: z.base64().max(1_000_000) })
      .strict()
      .parse(request.body);
    const session = listens.get(id);
    if (!session || session.owner !== ownerId || session.heard)
      throw Object.assign(new Error('This part of the call is no longer available.'), {
        statusCode: 404,
      });
    const pcm = Buffer.from(audio, 'base64');
    if (pcm.length % 2 || session.size + pcm.length > listenBytes)
      throw Object.assign(new Error('This part of the call is too long. Pause, then continue.'), {
        statusCode: 400,
      });
    session.chunks.push(pcm);
    session.size += pcm.length;
    session.expires = Date.now() + listenMs;
    void session.live.then((live) => live?.append(pcm));
    return { received: session.size };
  });
  app.delete<{ Params: { id: string } }>('/api/call/listen/:id', async (request) => {
    const id = z.uuid().parse(request.params.id);
    if (listens.get(id)?.owner === ownerId) dropListen(id);
    return { closed: true };
  });
  app.post('/api/call', async (request) => {
    const input = z
      .object({ threadId: z.uuid(), callId: z.uuid(), active: z.boolean() })
      .strict()
      .parse(request.body);
    setCall(input.threadId, input.callId, input.active);
    return { active: input.active };
  });
  app.get<{ Params: { id: string } }>('/api/call/audio/:id', async (request, reply) => {
    const clip = clips.get(z.uuid().parse(request.params.id));
    const missing = () =>
      Object.assign(new Error('This call audio is no longer available.'), { statusCode: 404 });
    if (!clip || clip.owner !== ownerId || clip.expires <= Date.now()) throw missing();
    while (!clip.mimeType && !clip.done) await next(clip);
    if (!clip.mimeType) throw missing();
    async function* read(source: Clip) {
      let index = 0;
      while (true) {
        while (index < source.chunks.length) yield source.chunks[index++];
        if (source.done) return;
        await next(source);
      }
    }
    return reply
      .header('Content-Type', clip.mimeType)
      .header('Cache-Control', 'no-store')
      .send(Readable.from(read(clip)));
  });
}
