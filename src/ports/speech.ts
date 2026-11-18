import type { SpeechVoice } from '../shared/speech.ts';

export class SpeechProviderError extends Error {
  readonly statusCode = 400;
}

export interface SpeechSynthesisOptions {
  voice?: string;
  stream?(chunk: Buffer, mimeType: string): void;
}

export interface LiveTranscription {
  append(pcm: Buffer): void;
  finish(signal?: AbortSignal): Promise<string>;
  close(): void;
}

export type LiveCallEvent =
  | { type: 'heard' | 'said'; text: string; startMs: number; endMs: number }
  | { type: 'delegated'; id: string }
  | { type: 'failed'; message: string }
  | { type: 'closed'; reason: string };

export interface LiveCallOptions {
  sdp: string;
  instructions: string;
  backendInstructions: string;
  handoff: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  voice?: string;
  onEvent(event: LiveCallEvent): void;
}

export interface LiveCall {
  answer: string;
  say(text: string, delegationId: string | null): void;
  note(text: string, delegationId: string | null): void;
  complete(callId: string, output: string): void;
  close(): void;
}

export interface GeneratedAudio {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}
export interface SpeechProvider {
  id: string;
  configured: boolean;
  transcriptionConfigured?: boolean;
  voices?: readonly SpeechVoice[];
  defaultVoice?: string;
  refreshVoices?(signal?: AbortSignal, force?: boolean): Promise<void>;
  synthesize(
    text: string,
    signal?: AbortSignal,
    report?: (usage: ProviderUsageEvent) => void,
    options?: SpeechSynthesisOptions,
  ): Promise<GeneratedAudio>;
  listen?(report?: (usage: ProviderUsageEvent) => void): Promise<LiveTranscription | undefined>;
  call?(
    options: LiveCallOptions,
    signal?: AbortSignal,
    report?: (usage: ProviderUsageEvent) => void,
  ): Promise<LiveCall>;
  transcribe?(
    audio: {
      bytes: Uint8Array;
      mimeType: string;
      name: string;
    },
    signal?: AbortSignal,
    report?: (usage: ProviderUsageEvent) => void,
  ): Promise<string>;
}
import type { ProviderUsageEvent } from './provider-usage.ts';

export interface LocalSpeechControls {
  prepare(signal?: AbortSignal): Promise<void>;
  prepareTranscription(signal?: AbortSignal): Promise<void>;
  status(): { state: 'not_downloaded' | 'downloading' | 'ready' | 'failed'; progress?: number };
  transcriptionStatus(): {
    state: 'not_downloaded' | 'downloading' | 'ready' | 'failed';
    progress?: number;
  };
  close(): Promise<void>;
}
