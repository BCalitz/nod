import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const heartbeatMs = 20_000;
const calls = new Map<string, Map<string, number>>();

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

export function registerCalls(app: FastifyInstance) {
  app.post('/api/call', async (request) => {
    const input = z
      .object({ threadId: z.uuid(), callId: z.uuid(), active: z.boolean() })
      .strict()
      .parse(request.body);
    setCall(input.threadId, input.callId, input.active);
    return { active: input.active };
  });
}
