import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GeneratedAudio } from '../ports/speech.ts';
import { callAudio } from './events.ts';

const heartbeatMs = 20_000;
const clipMs = 120_000;
const clipLimit = 64;
const calls = new Map<string, Map<string, number>>();
const clips = new Map<string, { owner: string; audio: GeneratedAudio; expires: number }>();

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

function keepClip(owner: string, audio: GeneratedAudio) {
  const now = Date.now();
  for (const [id, clip] of clips) if (clip.expires <= now) clips.delete(id);
  while (clips.size >= clipLimit) clips.delete(clips.keys().next().value!);
  const id = randomUUID();
  clips.set(id, { owner, audio, expires: now + clipMs });
  return id;
}

export function callSpeaker(input: {
  ownerId: string;
  threadId: string;
  turnId: string;
  signal: AbortSignal;
  synthesize(text: string): Promise<GeneratedAudio>;
  failed(error: unknown): void;
}) {
  const pending = new Map<string, string>();
  const spoken = new Set<string>();
  let sequence = 0;
  let order = Promise.resolve();
  const speak = (text: string) => {
    const clean = speakable(text).slice(0, 4096);
    if (!clean || input.signal.aborted) return;
    const index = sequence++;
    const audio = input.synthesize(clean);
    audio.catch(() => {});
    order = order.then(async () => {
      try {
        const result = await audio;
        if (input.signal.aborted || !inCall(input.threadId)) return;
        callAudio({
          ownerId: input.ownerId,
          threadId: input.threadId,
          turnId: input.turnId,
          id: keepClip(input.ownerId, result),
          sequence: index,
        });
      } catch (error) {
        if (!input.signal.aborted) input.failed(error);
      }
    });
  };
  return {
    push(text: string, streamId: string, done = false) {
      const buffered = (pending.get(streamId) ?? '') + text;
      if (done) {
        pending.delete(streamId);
        speak(buffered);
        spoken.add(streamId);
        return;
      }
      const boundary = Math.max(
        buffered.lastIndexOf('\n'),
        ...[...buffered.matchAll(/[.!?]["')\]]*(?=\s|$)/g)].map(
          (match) => match.index + match[0].length,
        ),
      );
      if (boundary > 0 && (sequence === 0 || boundary >= 80)) {
        speak(buffered.slice(0, boundary));
        pending.set(streamId, buffered.slice(boundary));
      } else pending.set(streamId, buffered);
    },
    spoke(streamId?: string) {
      return Boolean(streamId && spoken.has(streamId));
    },
    finished() {
      return order;
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
    if (!clip || clip.owner !== ownerId || clip.expires <= Date.now())
      throw Object.assign(new Error('This call audio is no longer available.'), {
        statusCode: 404,
      });
    return reply
      .header('Content-Type', clip.audio.mimeType)
      .header('Cache-Control', 'no-store')
      .send(clip.audio.bytes);
  });
}
