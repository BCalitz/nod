import { randomUUID } from 'node:crypto';
import type { LiveCall, LiveCallOptions } from '../../ports/speech.ts';
import { SpeechProviderError } from '../../ports/speech.ts';
import type { ProviderUsageEvent } from '../../ports/provider-usage.ts';
import { openAIRequestError } from './api.ts';

export const liveModel = 'gpt-live-1';
const backendModel = 'gpt-6-luna';
const dollarsPerSecond = 0.05 / 60;
const searchDollars = 0.01;
const liveVoices = new Set(
  'alloy ash ballad beacon bossa brise calandria cedar cinder compas coral delta destello echo flitz gleam halo harema hornero juni luciernaga marin meridian nira noeul nuri pearl quartz ripple sage shida shimmer sillage stone tempo verse vesper willow'.split(
    ' ',
  ),
);

type Fetch = typeof fetch;

export async function openLiveCall(
  connection: { key: string; url: string },
  options: LiveCallOptions,
  signal?: AbortSignal,
  report?: (usage: ProviderUsageEvent) => void,
  request: Fetch = fetch,
): Promise<LiveCall> {
  const voice = options.voice?.replace(/^openai:/, '');
  const response = await request(`${connection.url}/live/sessions`, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: `Bearer ${connection.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: {
        model: liveModel,
        instructions: options.instructions,
        audio: { output: { voice: voice && liveVoices.has(voice) ? voice : 'marin' } },
        delegation: {
          type: 'responses',
          responses: {
            model: backendModel,
            instructions: options.backendInstructions,
            reasoning: { effort: 'low' },
            text: { verbosity: 'low' },
            tool_choice: 'auto',
            parallel_tool_calls: false,
            tools: [
              { type: 'web_search' },
              {
                type: 'function',
                name: 'ask_nod',
                description: options.handoff,
                parameters: {
                  type: 'object',
                  properties: { request: { type: 'string' } },
                  required: ['request'],
                  additionalProperties: false,
                },
              },
            ],
          },
        },
        client: { data_channel: { allowed_client_events: [], allowed_server_events: [] } },
        input: options.history.slice(-128).map((item) => ({
          type: 'message',
          role: item.role,
          content: [{ type: item.role === 'user' ? 'input_text' : 'output_text', text: item.text }],
        })),
      },
      transport: { type: 'webrtc', sdp: options.sdp },
    }),
    signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok)
    throw new SpeechProviderError(
      `OpenAI could not start the live call: ${(await openAIRequestError(response, connection.key)).message}`,
    );
  const created = (await response.json()) as {
    session?: { id?: unknown };
    transport?: { sdp?: unknown };
  };
  const id = created.session?.id;
  const answer = created.transport?.sdp;
  if (typeof id !== 'string' || typeof answer !== 'string')
    throw new SpeechProviderError('OpenAI started the live call without a connection answer.');
  let billed = 0;
  const bill = (seconds: unknown) => {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= billed) return;
    const added = seconds - billed;
    billed = seconds;
    report?.({
      id: randomUUID(),
      provider: 'openai',
      category: 'agent',
      operation: 'call',
      model: liveModel,
      status: 'succeeded',
      durationMs: Math.round(added * 1000),
      costUsd: added * dollarsPerSecond,
      pricing: 'sdk_estimate',
    });
  };
  bill(15);
  const socket = new WebSocket(
    `${connection.url.replace(/^http/, 'ws')}/live/sessions/${encodeURIComponent(id)}/attach`,
    { headers: { Authorization: `Bearer ${connection.key}` } } as unknown as string[],
  );
  const queued: string[] = [];
  const seen = new Set<string>();
  let closed = false;
  const send = (event: object) => {
    const data = JSON.stringify(event);
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
    else if (socket.readyState === WebSocket.CONNECTING) queued.push(data);
  };
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    options.onEvent({ type: 'closed', reason });
  };
  socket.onopen = () => {
    for (const data of queued.splice(0)) socket.send(data);
  };
  socket.onmessage = (message) => {
    let event: {
      type?: string;
      event_id?: unknown;
      delta?: unknown;
      start_ms?: unknown;
      end_ms?: unknown;
      offset_ms?: unknown;
      event?: {
        type?: string;
        item?: { type?: unknown; name?: unknown; call_id?: unknown };
        response?: {
          usage?: {
            input_tokens?: unknown;
            output_tokens?: unknown;
            input_tokens_details?: { cached_tokens?: unknown };
          };
        };
      };
      usage?: { seconds?: unknown };
      reason?: unknown;
      error?: { message?: unknown; code?: unknown };
    };
    try {
      event = JSON.parse(String(message.data));
    } catch {
      return;
    }
    if (typeof event.event_id === 'string') {
      if (seen.has(event.event_id)) return;
      seen.add(event.event_id);
    }
    if (
      (event.type === 'session.input_transcript.delta' ||
        event.type === 'session.output_transcript.delta') &&
      typeof event.delta === 'string'
    )
      options.onEvent({
        type: event.type === 'session.input_transcript.delta' ? 'heard' : 'said',
        text: event.delta,
        startMs: Number(event.start_ms) || 0,
        endMs: Number(event.end_ms) || 0,
      });
    else if (event.type === 'response.event') {
      const nested = event.event;
      const item = nested?.item;
      if (nested?.type === 'response.output_item.done' && item?.type === 'web_search_call')
        report?.({
          id: randomUUID(),
          provider: 'openai',
          category: 'agent',
          operation: 'call_search',
          model: backendModel,
          status: 'succeeded',
          durationMs: 0,
          costUsd: searchDollars,
          pricing: 'sdk_estimate',
        });
      else if (
        nested?.type === 'response.output_item.done' &&
        item?.type === 'function_call' &&
        item.name === 'ask_nod' &&
        typeof item.call_id === 'string'
      )
        options.onEvent({ type: 'delegated', id: item.call_id });
      else if (nested?.type === 'response.completed' && nested.response?.usage) {
        const count = (value: unknown) =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
        const usage = nested.response.usage;
        const input = count(usage.input_tokens);
        const cached = Math.min(input, count(usage.input_tokens_details?.cached_tokens));
        const output = count(usage.output_tokens);
        report?.({
          id: randomUUID(),
          provider: 'openai',
          category: 'agent',
          operation: 'call_answer',
          model: backendModel,
          status: 'succeeded',
          durationMs: 0,
          inputTokens: input - cached,
          cacheReadTokens: cached,
          outputTokens: output,
          costUsd: ((input - cached) * 0.1 + cached * 0.01 + output * 0.5) / 1e6,
          pricing: 'sdk_estimate',
        });
      }
    } else if (event.type === 'session.usage.updated') bill(event.usage?.seconds);
    else if (event.type === 'session.closed') {
      bill(event.usage?.seconds);
      finish(typeof event.reason === 'string' ? event.reason : 'closed');
    } else if (event.type === 'error')
      options.onEvent({
        type: 'failed',
        message: `OpenAI live call error: ${String(event.error?.message ?? event.error?.code ?? 'unknown')}`,
      });
  };
  socket.onclose = () => finish('connection_lost');
  const append = (type: string, text: string, delegationId: string | null) => {
    const content = text.trim().slice(0, 1800);
    if (content && !closed)
      send({ type, event_id: randomUUID(), delegation_id: delegationId, content });
  };
  return {
    answer,
    say: (text, delegationId) => append('session.commentary.append', text, delegationId),
    note: (text, delegationId) => append('session.thinking.append', text, delegationId),
    complete(callId, output) {
      if (closed) return;
      send({
        type: 'response.item.create',
        event_id: randomUUID(),
        item: { type: 'function_call_output', call_id: callId, output },
      });
      send({ type: 'response.create', event_id: randomUUID() });
    },
    close() {
      if (closed) return;
      send({ type: 'session.close' });
      setTimeout(() => socket.close(), 5_000).unref?.();
    },
  };
}
