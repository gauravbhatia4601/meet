import { useRef, useState } from 'react';

interface CommandBarProps {
  onCommand: (raw: string) => void;
}

/**
 * Terminal-style control bar. There are no media toggle buttons — the user
 * drives the call by typing slash commands (e.g. /mute, /cam, /share, /exit).
 * The three shortcut buttons just run the matching command for convenience.
 */
export default function CommandBar({ onCommand }: CommandBarProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const raw = value.trim();
    if (!raw) return;
    onCommand(raw);
    setValue('');
  }

  return (
    <form className="cmdbar terminal-border" onSubmit={submit} role="search" aria-label="Call command bar">
      <span className="cmdbar__prompt" aria-hidden="true">&gt;</span>
      <input
        ref={inputRef}
        className="cmdbar__input"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="enter command (/mute, /cam, /share, /hand, /exit)"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-label="Command input"
        autoCorrect="off"
      />
      <div className="cmdbar__btns">
        <button type="button" className="cmdbar__btn" onClick={() => onCommand('/mute')}>
          /mute
        </button>
        <button type="button" className="cmdbar__btn" onClick={() => onCommand('/cam')}>
          /cam
        </button>
        <button type="button" className="cmdbar__btn cmdbar__btn--danger" onClick={() => onCommand('/exit')}>
          /exit
        </button>
      </div>
    </form>
  );
}