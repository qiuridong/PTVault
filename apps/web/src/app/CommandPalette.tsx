import { Command, CornerDownLeft, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { navigationItems } from './navigation.js';

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * Keyboard navigation for the console.
 *
 * Navigation only. Nothing here starts, cancels, or deletes anything: a fuzzy
 * list one keystroke from Enter is the wrong place to keep an action that moves
 * or removes bytes, and every such action in this product deliberately costs a
 * fresh MFA code and a confirmation panel. The palette exists because an
 * operator moving between torrents, transfers and media does it dozens of times
 * an hour, not to make the dangerous things faster.
 */
export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === '') return navigationItems;
    return navigationItems.filter(
      (item) =>
        item.label.toLocaleLowerCase().includes(needle) ||
        item.path.toLocaleLowerCase().includes(needle) ||
        item.hint.toLocaleLowerCase().includes(needle),
    );
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const go = (path: string): void => {
    onClose();
    void navigate(path);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setCursor((current) => (current + step + matches.length) % matches.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const target = matches[Math.min(cursor, matches.length - 1)];
      if (target) go(target.path);
    }
  };

  return (
    <div
      className="command-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="command-panel" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="command-input-row">
          <Search size={17} strokeWidth={1.8} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            aria-label="跳转到页面"
            placeholder="跳转到…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
          />
        </div>

        {matches.length === 0 ? (
          <p className="command-empty">没有匹配的页面。</p>
        ) : (
          <ul className="command-results">
            {matches.map((item, index) => {
              const Icon = item.icon;
              return (
                <li key={item.path}>
                  <button
                    type="button"
                    className="command-item"
                    data-active={index === Math.min(cursor, matches.length - 1) || undefined}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => go(item.path)}
                  >
                    <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
                    <span>{item.label}</span>
                    <span className="command-item-hint">{item.hint}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <footer className="command-footer">
          <span>
            <Command size={11} strokeWidth={2} aria-hidden="true" /> K 打开
          </span>
          <span>↑↓ 选择</span>
          <span>
            <CornerDownLeft size={11} strokeWidth={2} aria-hidden="true" /> 跳转
          </span>
          <span>Esc 关闭</span>
        </footer>
      </div>
    </div>
  );
}
