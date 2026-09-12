import { useCallback } from 'react';

import { useReducedMotion } from './useReducedMotion.js';

/**
 * Staggered entrance for a group of panels.
 *
 * Deliberately **not** scroll-triggered. An `IntersectionObserver` reveal looks
 * good in a portfolio and is the wrong mechanism here: anything the observer
 * fails to fire for stays at `opacity: 0`, which on this console means a disk
 * meter or an alert list that silently is not on the page. That failure mode is
 * indistinguishable, to the reader, from "there is nothing to report" — and it
 * really happens (a full-page capture that never scrolls reproduces it exactly).
 *
 * So the animation runs once on mount, delay included, and finishes whether or
 * not the element was ever looked at. Under reduced motion the attribute is
 * never written and the element is simply there.
 */
export function useReveal<T extends HTMLElement>(delayMs = 0): (node: T | null) => void {
  const reduced = useReducedMotion();

  return useCallback(
    (node: T | null) => {
      if (node === null || reduced) return;
      if (delayMs > 0) node.style.setProperty('--reveal-delay', `${delayMs}ms`);
      node.dataset.reveal = 'in';
    },
    [delayMs, reduced],
  );
}
