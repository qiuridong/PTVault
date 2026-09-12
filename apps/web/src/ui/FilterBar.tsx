import { Check, ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

/**
 * The filter surface shared by the torrents, transfers and audit pages.
 *
 * Three rules, taken from tools that solved this before us — GitHub's issue
 * filters, Linear's view bar, Notion's filter popover:
 *
 * 1. **The bar does not grow.** The search box and the one or two controls an
 *    operator touches on every visit stay on one row; the rest lives behind a
 *    disclosure carrying a count. Six chip groups laid out flat is what made
 *    this page unreadable: the control used every time and the one used twice a
 *    year had exactly the same weight.
 * 2. **Collapsing must never hide what is applied.** Anything currently
 *    narrowing the table is echoed as a removable token on the bar, so the
 *    closed state still answers "why am I only seeing six rows".
 * 3. **Selected is a shape, not a shade.** A pressed chip gets a check glyph as
 *    well as a fill. State carried by colour alone fails the colour-blind
 *    reader and the one glancing at a washed-out screen.
 *
 * The whole thing stays inside one named region on purpose. The E2E safety
 * sentinel asserts that every button whose label contains a destructive word
 * (「待删除」, 「已暂停」) lives inside the filter region — those are states to
 * filter by, and the assertion is what stops a real delete button from ever
 * quietly joining them.
 */
export type FilterToken = {
  /** Stable list key. */
  key: string;
  /** Which group the value came from, e.g. 「云端状态」. */
  group: string;
  label: string;
  onRemove: () => void;
};

export type FilterBarProps = {
  /** Accessible name of the region. Part of the safety sentinel's contract. */
  label: string;
  /** Row one: the search field and at most a couple of selects. */
  children: ReactNode;
  /** Row two, always visible: the page's primary view switch. */
  views?: ReactNode;
  /** Right side of row two: counts and other read-only status. */
  meta?: ReactNode;
  /** Collapsible content — the chip groups nobody needs on every visit. */
  panel?: ReactNode;
  /** What is currently applied from inside `panel`, so collapsing hides nothing. */
  tokens?: readonly FilterToken[] | undefined;
  /** Passed only while something is actually applied; also drives the accent rule. */
  onClear?: (() => void) | undefined;
  /** One line stating what the filters do and do not cover. */
  note?: string | undefined;
};

export function FilterBar({
  label,
  children,
  views,
  meta,
  panel,
  tokens = [],
  onClear,
  note,
}: FilterBarProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const filtered = onClear !== undefined;
  // With nothing to echo, "清除筛选" alone would take a whole row of its own. It
  // rides along at the end of the views row instead, and only claims a row when
  // there is no views row to ride on.
  const inlineClear =
    filtered && tokens.length === 0 && (views !== undefined || meta !== undefined);
  const clearButton = onClear ? (
    <button type="button" className="filter-clear" onClick={onClear}>
      清除筛选
    </button>
  ) : null;

  return (
    <section className="filter-bar" aria-label={label} data-filtered={filtered}>
      <div className="filter-bar-row">
        {children}
        {panel ? (
          <button
            type="button"
            className="filter-toggle"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
          >
            <SlidersHorizontal size={15} strokeWidth={1.9} aria-hidden="true" />
            <span>更多筛选</span>
            {tokens.length > 0 ? <span className="filter-count">{tokens.length}</span> : null}
            <ChevronDown className="filter-chevron" size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {views || meta || inlineClear ? (
        <div className="filter-bar-views">
          {views}
          {meta || inlineClear ? (
            <div className="filter-bar-meta">
              {meta}
              {inlineClear ? clearButton : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {tokens.length > 0 || (filtered && !inlineClear) ? (
        <ul className="filter-tokens" aria-label="已应用的筛选">
          {tokens.map((token) => (
            <li key={token.key}>
              <button type="button" className="filter-token" onClick={token.onRemove}>
                <span className="filter-token-group">{token.group}</span>
                <span>{token.label}</span>
                <X size={13} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </li>
          ))}
          {clearButton ? <li>{clearButton}</li> : null}
        </ul>
      ) : null}

      {panel ? (
        // `inert` rather than `hidden`: the row-height transition needs the panel
        // laid out, and content that is visually collapsed must stay out of the
        // tab order regardless.
        <div className="filter-panel-wrap" data-open={open}>
          <div className="filter-panel" id={panelId} inert={!open}>
            <div className="filter-panel-inner">
              {panel}
              {note ? <p className="filter-note">{note}</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export type ChipOption<T extends string> = {
  value: T;
  label: string;
  /** Rendered after the label — a count, usually. */
  suffix?: string;
};

/** A multi-select row of chips. Nothing here acts on a torrent. */
export function ChipGroup<T extends string>({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: ReadonlyArray<ChipOption<T>>;
  selected: readonly T[];
  onToggle: (value: T) => void;
}) {
  const labelId = useId();
  return (
    <div className="filter-group">
      <span className="filter-group-label" id={labelId}>
        {label}
      </span>
      <div className="filter-chips" role="group" aria-labelledby={labelId}>
        {options.map((option) => {
          const pressed = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              className="filter-chip"
              aria-pressed={pressed}
              onClick={() => onToggle(option.value)}
            >
              <Check className="filter-chip-check" size={13} strokeWidth={2.6} aria-hidden="true" />
              <span>{option.label}</span>
              {option.suffix === undefined ? null : (
                <span className="filter-chip-suffix">{option.suffix}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A single-choice view switch, drawn as one control rather than N loose buttons.
 *
 * For the page's primary partition — the transfer groups, the audit action
 * families, the saved torrent views — which is read on arrival and so stays on
 * screen instead of hiding behind the disclosure. `value` may name an option
 * that is not in the list, which renders as "none selected": that is the honest
 * state after an operator picks a preset and then edits one chip out of it.
 */
export function SegmentedTabs<T extends string>({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: ReadonlyArray<ChipOption<T>>;
  value: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      <span className="segmented-label">{label}</span>
      <div className="segmented-track">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="segmented-option"
            aria-pressed={value === option.value}
            onClick={() => onSelect(option.value)}
          >
            <span>{option.label}</span>
            {option.suffix === undefined ? null : (
              <span className="segmented-count">{option.suffix}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
