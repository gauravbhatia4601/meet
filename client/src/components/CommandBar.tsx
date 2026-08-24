import { useRef, useState } from 'react';
import { suggestCommands, type CommandDef } from '../lib/commands';

interface CommandBarProps {
  onCommand: (raw: string) => void;
}

/**
 * Terminal-style control bar. There are no media toggle buttons — the user
 * drives the call by typing slash commands. Typing "/" lists every available
 * command; typing more filters the list. The list is keyboard-navigable
 * (Up/Down to move, Enter to run the highlighted one, Esc to clear). The three
 * shortcut buttons just run the matching command for convenience.
 */
export default function CommandBar({ onCommand }: CommandBarProps) {
  const [value, setValue] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = value.trim();
  const showSuggest = trimmed.startsWith('/');
  const query = showSuggest ? trimmed.slice(1) : '';
  const suggestions = showSuggest ? suggestCommands(query) : [];

  function run(s: string) {
    onCommand(s);
    setValue('');
    setHighlight(-1);
    inputRef.current?.focus();
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    if (showSuggest && suggestions[highlight]) {
      run(suggestions[highlight].label);
    } else {
      run(trimmed);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setValue('');
      setHighlight(-1);
      return;
    }
    if (!showSuggest || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h < 0 ? 0 : Math.min(h + 1, suggestions.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h < 0 ? suggestions.length - 1 : Math.max(h - 1, 0)));
    }
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setValue(v);
    setHighlight(v.trim().startsWith('/') ? 0 : -1);
  }

  function pick(cmd: CommandDef) {
    run(cmd.label);
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
          onChange={onChange}
          onKeyDown={onKeyDown}
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
            {suggestions.map((c, i) => (
              <li key={c.name} role="option" aria-selected={i === highlight}>
                <button
                  type="button"
                  className={`cmdbar__suggest-item${i === highlight ? ' cmdbar__suggest-item--active' : ''}`}
                  onClick={() => pick(c)}
                  onMouseEnter={() => setHighlight(i)}
                >
                  <span className="cmdbar__suggest-cmd">{c.label}</span>
                  <span className="cmdbar__suggest-desc">{c.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="cmdbar__btns">
        <button type="button" className="cmdbar__btn" onClick={() => run('/mute')}>
          /mute
        </button>
        <button type="button" className="cmdbar__btn" onClick={() => run('/cam')}>
          /cam
        </button>
        <button type="button" className="cmdbar__btn cmdbar__btn--danger" onClick={() => run('/exit')}>
          /exit
        </button>
      </div>
    </form>
  );
}