import { useEffect, useState } from 'react';

/** Anchors keep native keyboard/history behavior; visible geometry owns current state. */
export function useSettingsScrollSpy() {
  const [nav, setNav] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!nav) return;
    const links = [...nav.querySelectorAll<HTMLAnchorElement>(':scope > a[href^="#"]')];
    const sections = links.flatMap((link) => {
      const section = document.getElementById(link.hash.slice(1));
      return section ? [{ link, section }] : [];
    });
    let frame = 0;
    let previousLink: HTMLAnchorElement | undefined;
    const update = () => {
      frame = 0;
      let current = sections[0];
      for (const entry of sections) {
        if (entry.section.getBoundingClientRect().top <= 64) current = entry;
      }
      let scrollRoot = document.scrollingElement ?? document.documentElement;
      for (let parent = sections[0]?.section.parentElement; parent; parent = parent.parentElement) {
        if (
          /(auto|scroll)/.test(getComputedStyle(parent).overflowY) &&
          parent.scrollHeight > parent.clientHeight
        ) {
          scrollRoot = parent;
          break;
        }
      }
      const last = sections.at(-1);
      if (
        last &&
        scrollRoot.scrollTop > 0 &&
        scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 2 &&
        last.section.getBoundingClientRect().top < window.innerHeight
      )
        current = last;
      for (const entry of sections) {
        if (entry === current) entry.link.setAttribute('aria-current', 'location');
        else entry.link.removeAttribute('aria-current');
      }
      // Narrow rails scroll horizontally. Keep the new current link visible,
      // without moving document scroll or stealing keyboard focus.
      if (current && current.link !== previousLink && nav.scrollWidth > nav.clientWidth) {
        const rail = nav.getBoundingClientRect();
        const link = current.link.getBoundingClientRect();
        if (link.left < rail.left) nav.scrollLeft += link.left - rail.left;
        else if (link.right > rail.right) nav.scrollLeft += link.right - rail.right;
      }
      previousLink = current?.link;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // Capture also observes a scrolling app panel, not only the window.
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    window.addEventListener('hashchange', schedule);
    window.addEventListener('popstate', schedule);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    for (const { section } of sections) observer?.observe(section);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('hashchange', schedule);
      window.removeEventListener('popstate', schedule);
    };
  }, [nav]);
  return setNav;
}
