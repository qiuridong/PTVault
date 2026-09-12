import { CircleSlash, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { useReveal } from '../../showcase/useReveal.js';

/**
 * Whether a band of a settings page has a backend behind it.
 *
 * Three values rather than two, because 「读不到」 hides three different next
 * moves: the API on this box is older than this bundle, the thing is not
 * configured on this host, or it is configured and answering.
 */
export type SectionState = 'live' | 'partial' | 'absent';

const STATE_LABELS: Record<SectionState, string> = {
  live: '已接入',
  partial: '部分可用',
  absent: '还没建',
};

/**
 * One band of a settings page.
 *
 * `state` sits on the header rather than inside the body because the first
 * question these pages answer is which parts actually work today; reading that
 * off the headings should not require reading the paragraphs.
 *
 * Shared by `/settings` and `/settings/netdisk` so the two pages cannot drift
 * into two different vocabularies for the same three verdicts.
 */
export function SettingsSection({
  index,
  id,
  title,
  icon: Icon,
  lede,
  state,
  children,
}: {
  index: string;
  id: string;
  title: string;
  icon: LucideIcon;
  lede: string;
  state: SectionState;
  children: ReactNode;
}) {
  const revealRef = useReveal<HTMLElement>(Number(index));
  return (
    <section ref={revealRef} className="settings-section" id={id} aria-labelledby={`${id}-title`}>
      <header className="settings-section-head">
        <span className="settings-numeral" aria-hidden="true">
          {index}
        </span>
        <span className="settings-section-icon" aria-hidden="true">
          <Icon size={18} strokeWidth={1.8} />
        </span>
        <div className="settings-section-titles">
          <h2 id={`${id}-title`}>{title}</h2>
          <p className="settings-lede">{lede}</p>
        </div>
        <span className={`settings-state settings-state-${state}`}>{STATE_LABELS[state]}</span>
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

/**
 * A section with no surface yet, stating what is missing and what answers the
 * same question today.
 *
 * An empty frame on an operations console reads as a failed request, and the
 * operator's next move is to go check whether the backend is down — a wasted
 * trip. Naming the gap costs one paragraph and saves that trip.
 */
export function NotBuilt({ children }: { children: ReactNode }) {
  return (
    <div className="settings-notbuilt">
      <span className="settings-notbuilt-glyph" aria-hidden="true">
        <CircleSlash size={18} strokeWidth={1.7} />
      </span>
      <div>{children}</div>
    </div>
  );
}
