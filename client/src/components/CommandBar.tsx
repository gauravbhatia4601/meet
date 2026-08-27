import { useEffect, useRef, useState } from 'react';
import { suggestCommands } from '../lib/commands';

interface Suggestion {
  label: string;
  description: string;
}

interface CommandBarProps {
  onCommand: (raw: string) => void;
  /** User-defined aliases, surfaced alongside built-in commands. */
  aliases?: Suggestion[];
  /** Lets the page focus the input (e.g. on the "/" shortcut). */
  inputRef?: React.RefObject<HTMLInputElement>;
}

/**
 * Terminal-style control bar. There are no media toggle buttons — the user
 * drives the call by typing slash commands. Typing "/" lists every available
 * command (built-ins + aliases); typing more filters. The list is
 * keyboard-navigable (Up/Down, Enter, Esc). Only keyboard navigation scrolls
 * the list (hover does not). When not browsing suggestions, Up/Down recall
 * command history (shell-style). Clicking outside closes the list.
 */
export default function CommandBar({ onCommand, aliases = [], inputRef }: CommandBarProps) {
  const [value, setValue] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const [, setHistIndex] = useState(-1);
  const [history, setHistory] = useState<string[]>([]);
  const internalRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const keyboardNavRef = useRef(true);
  const suppressHoverRef = useRef(false);
  const ref = inputRef ?? internalRef;

  const trimmed = value.trim();
  const showSuggest = trimmed.startsWith('/');
  const query = showSuggest ? trimmed.slice(1) : '';
  const suggestions: Suggestion[] = showSuggest
    ? [
        ...suggestCommands(query).map((c) => ({ label: c.label, description: c.description })),
        ...aliases.filter((a) => a.label.slice(1).toLowerCase().startsWith(query)),
      ]
    : [];

  // Scroll the highlighted item into view ONLY on keyboard navigation (not
  // hover). Suppress the spurious mouseenter the browser fires when an item
  // scrolls under a stationary cursor, so the highlight doesn't jump.
  useEffect(() => {
    if (highlight < 0 || !keyboardNavRef.current) return;
    const list = listRef.current;
    if (!list) return;
    suppressHoverRef.current = true;
    const item = list.children[highlight] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
    requestAnimationFrame(() => {
      suppressHoverRef.current = false;
    });
  }, [highlight]);

  // Click outside the command bar closes the list.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (formRef.current && !formRef.current.contains(e.target as Node)) {
        setValue('');
        setHighlight(-1);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  function run(raw: string) {
    const cmd = raw.trim();
    if (!cmd) return;
    onCommand(cmd);
    setHistory((h) => (h[h.length - 1] === cmd ? h : [...h, cmd]));
    setHistIndex(-1);
    setValue('');
    setHighlight(-1);
    ref.current?.focus();
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    if (showSuggest && suggestions[highlight]) run(suggestions[highlight].label);
    else run(trimmed);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    keyboardNavRef.current = true;
    if (e.key === 'Escape') {
      setValue('');
      setHighlight(-1);
      setHistIndex(-1);
      return;
    }
    if (showSuggest && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (h < 0 ? 0 : Math.min(h + 1, suggestions.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h < 0 ? suggestions.length - 1 : Math.max(h - 1, 0)));
      }
      return;
    }
    // Shell-style history recall when not browsing suggestions.
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      setHistIndex((i) => {
        const next = i < 0 ? history.length - 1 : Math.max(0, i - 1);
        setValue(history[next] ?? '');
        return next;
      });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (history.length === 0) return;
      setHistIndex((i) => {
        if (i < 0) return -1;
        const next = i + 1;
        if (next >= history.length) {
          setValue('');
          return -1;
        }
        setValue(history[next] ?? '');
        return next;
      });
    }
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    keyboardNavRef.current = true;
    const v = e.target.value;
    setValue(v);
    setHighlight(v.trim().startsWith('/') ? 0 : -1);
    setHistIndex(-1);
  }

  function pick(s: Suggestion) {
    run(s.label);
  }

  return (
    <form ref={formRef} className="cmdbar terminal-border" onSubmit={submit} role="search" aria-label="Call command bar">
      <span className="cmdbar__prompt" aria-hidden="true">&gt;</span>
      <div className="cmdbar__field">
        <input
          ref={ref}
          className="cmdbar__input"
          type="text"
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder="enter command (/mute, /cam, /share, /hand, /exit) — ↑/↓ for history"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoCorrect="off"
          aria-label="Command input"
          aria-expanded={suggestions.length > 0}
          aria-autocomplete="list"
        />
        {suggestions.length > 0 && (
          <ul className="cmdbar__suggest" role="listbox" aria-label="Available commands" ref={listRef}>
            {suggestions.map((c, i) => (
              <li key={c.label} role="option" aria-selected={i === highlight}>
                <button
                  type="button"
                  className={`cmdbar__suggest-item${i === highlight ? ' cmdbar__suggest-item--active' : ''}`}
                  onClick={() => pick(c)}
                  onMouseEnter={() => {
                    if (suppressHoverRef.current) return;
                    keyboardNavRef.current = false;
                    setHighlight(i);
                  }}
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
        <button type="button" className="cmdbar__btn" onClick={() => run('/mute')}>/mute</button>
        <button type="button" className="cmdbar__btn" onClick={() => run('/cam')}>/cam</button>
        <button type="button" className="cmdbar__btn cmdbar__btn--danger" onClick={() => run('/exit')}>/exit</button>
      </div>
    </form>
  );
}