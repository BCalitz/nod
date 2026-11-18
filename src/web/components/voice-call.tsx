import type { CSSProperties } from 'react';
import type { Message } from '../../shared/contracts';
import { useVoiceCall, type CallPhase } from '../hooks/use-voice-call';
import { Mic, MicOff, PhoneOff, Square } from './icons';
import { Button, Notice } from './ui';

const labels: Record<CallPhase, string> = {
  starting: 'Connecting…',
  listening: 'Listening',
  hearing: 'Hearing you',
  sending: 'Sending',
  thinking: 'Thinking',
  speaking: 'Speaking',
  failed: 'Call ended',
};

export function VoiceCall({
  threadId,
  working,
  messages,
  send,
  onEnd,
}: {
  threadId: string;
  working: boolean;
  messages: Message[];
  send(recording: File): Promise<boolean>;
  onEnd(): void;
}) {
  const call = useVoiceCall({ threadId, active: true, working, messages, send });
  const label = call.muted && call.phase !== 'failed' ? 'Muted' : labels[call.phase];
  return (
    <section className="voice-call" aria-label="Voice call">
      {call.error && <Notice kind="error">{call.error}</Notice>}
      <div className="voice-call-bar">
        <span
          className={`voice-call-orb is-${call.muted ? 'muted' : call.phase}`}
          style={{ '--level': call.muted ? 0 : call.level } as CSSProperties}
          aria-hidden="true"
        />
        <span className="voice-call-status" role="status">
          {label}
        </span>
        {call.phase === 'speaking' && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Stop speaking"
            title="Stop speaking"
            onClick={call.interrupt}
          >
            <Square size={14} solid />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={call.muted ? 'Unmute' : 'Mute'}
          title={call.muted ? 'Unmute' : 'Mute'}
          aria-pressed={call.muted}
          disabled={call.phase === 'failed'}
          onClick={() => call.setMuted(!call.muted)}
        >
          {call.muted ? <MicOff size={16} /> : <Mic size={16} />}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="voice-call-end"
          onClick={onEnd}
        >
          <PhoneOff size={16} />
          End call
        </Button>
      </div>
    </section>
  );
}
