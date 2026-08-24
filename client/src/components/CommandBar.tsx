import { useRef, useState } from 'react';
import { suggestCommands, type CommandDef } from '../lib/commands';

interface CommandBarProps {
  onCommand: (raw: string) => void;
}

/**
 * Terminal-style control bar. There are no media toggle buttons — the user
 * drives the call by typing slash commands. Typing "/" lists every available
 * command; typing more filters the list. The three shortcut buttons just run
 * the matching command for convenience.
 */
export default function CommandBar({ onCommand }: CommandBarProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = value.trim();
  const showSuggest = trimmed.startsWith('/');
  const query = showSuggest ? trimmed.slice(1) : '';
  const suggestions = showSuggest ? suggestCommands(query) : [];

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const raw = value.trim();
    if (!raw) return;
    onCommand(raw);
    setValue('');
  }

  function pick(cmd: CommandDef) {
    onCommand(cmd.label);
    setValue('');
    inputRef.current?.focus();
  }

  return (
    <form className="cmdbar terminal-border" onSubmit={submit} role="search" aria-label="Call command bar">
      <span className="cmdbar__prompt" aria-hidden="true">&gt;</span>
      <div className="cmdbar__field">
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
          autoCorrect="off"
          aria-label="Command input"
          aria-expanded={suggestions.length > 0}
          aria-autocomplete="list"
        />
        {suggestions.length > 0 && (
          <ul className="cmdbar__suggest" role="listbox" aria-label="Available commands">
            {suggestions.map((c) => (
              <li key={c.name} role="option" aria-selected={false}>
                <button type="button" className="cmdbar__suggest-item" onClick={() => pick(c)}>
                  <span className="cmdbar__suggest-cmd">{c.label}</span>
                  <span className="cmdbar__suggest-desc">{c.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
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