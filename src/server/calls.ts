import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const heartbeatMs = 20_000;
const calls = new Map<string, number>();

export function inCall(threadId: string) {
  const until = calls.get(threadId);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  calls.delete(threadId);
  return false;
}

export function setCall(threadId: string, active: boolean) {
  if (active) calls.set(threadId, Date.now() + heartbeatMs);
  else calls.delete(threadId);
}

export function registerCalls(app: FastifyInstance) {
  app.post('/api/call', async (request) => {
    const input = z
      .object({ threadId: z.uuid(), active: z.boolean() })
      .strict()
      .parse(request.body);
    setCall(input.threadId, input.active);
    return { active: input.active };
  });
}
