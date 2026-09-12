import { CircleSlash, Gauge, Lock } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * How much of a declared dimension actually exists on this deployment.
 *
 * `ENFORCED` is a limit the executor really applies; `REPORTED` is a reading the
 * API returns; `ABSENT` is a dimension that exists only in the design. The
 * distinction is the whole point of these rows: a settings page that rendered an
 * `ABSENT` dimension as an input would offer a limit nothing enforces, and one
 * that rendered it as `0` would report an occupancy nobody measured.
 */
export type SlotAvailability = 'ENFORCED' | 'REPORTED' | 'ABSENT';

const AVAILABILITY_LABELS: Record<SlotAvailability, string> = {
  ENFORCED: '已强制',
  REPORTED: '已上报',
  ABSENT: '后端尚未提供',
};

function AvailabilityIcon({ availability }: { availability: SlotAvailability }) {
  switch (availability) {
    case 'ENFORCED':
      return <Lock size={13} strokeWidth={1.9} aria-hidden="true" />;
    case 'REPORTED':
      return <Gauge size={13} strokeWidth={1.9} aria-hidden="true" />;
    default:
      return <CircleSlash size={13} strokeWidth={1.9} aria-hidden="true" />;
  }
}

/**
 * One read-only row naming a dimension, what it means, and whether the server
 * can currently answer for it.
 *
 * Read-only by construction. These rows are how a capability-driven page keeps a
 * design document's vocabulary visible without pretending the vocabulary is
 * already wired: the day a resource gains a real permit and a real reading, the
 * row becomes a control or a figure, and nothing else about the page moves.
 *
 * The state is carried by text as well as by colour and glyph — a reader who
 * cannot distinguish the accent from the muted border still reads 「已强制」 or
 * 「后端尚未提供」.
 */
export function CapabilitySlot({
  label,
  availability,
  meaning,
  reading,
  children,
}: {
  label: string;
  availability: SlotAvailability;
  /** What the dimension covers, in the operator's words. */
  meaning: ReactNode;
  /** The figure, when the API really reports one. */
  reading?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`capability-slot capability-slot-${availability.toLowerCase()}`}>
      <div className="capability-slot-head">
        <span className="capability-slot-label">{label}</span>
        <span className={`capability-badge capability-badge-${availability.toLowerCase()}`}>
          <AvailabilityIcon availability={availability} />
          {AVAILABILITY_LABELS[availability]}
        </span>
      </div>
      {reading === undefined ? null : <p className="capability-slot-reading">{reading}</p>}
      <p className="capability-slot-meaning">{meaning}</p>
      {children}
    </div>
  );
}
