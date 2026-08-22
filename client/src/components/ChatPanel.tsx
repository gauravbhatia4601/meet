import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';

interface ChatPanelProps {
  messages: ChatMessage[];
  mySocketId: string;
  onSend: (text: string) => void;
  onClose: () => void;
}

export default function ChatPanel({ messages, mySocketId, onSend, onClose }: ChatPanelProps) {
  const [text, setText] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    bottomRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
  }, [messages]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  }

  return (
    <div className="chat">
      <div className="chat__header">
        <span className="chat__title">In-call messages</span>
        <button onClick={onClose} className="chat__close" aria-label="Close chat">✕</button>
      </div>

      <div className="chat__list" aria-live="polite" aria-relevant="additions">
        {messages.length === 0 && (
          <p className="chat__empty">Say hello to start the conversation.</p>
        )}
        {messages.map((m, i) => {
          const mine = m.from === mySocketId;
          return (
            <div key={i} className={`chat__bubble${mine ? ' chat__bubble--mine' : ''}`}>
              {!mine && (
                <div className="chat__sender">{m.senderName}</div>
              )}
              <div className="chat__text">{m.text}</div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={submit} className="chat__form">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Send a message…"
          name="message"
          autoComplete="off"
          className="chat__input"
          aria-label="Message"
        />
        <button type="submit" className="btn btn-primary">Send</button>
      </form>
    </div>
  );
}
