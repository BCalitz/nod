import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GeneratedAudio } from '../ports/speech.ts';
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

export function registerCalls(app: FastifyInstance, ownerId: string) {
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
