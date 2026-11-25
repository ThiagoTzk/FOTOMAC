import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject, type ComponentRef } from 'react';
import { createPortal } from 'react-dom';
import type { View } from 'react-native';

import { siteScale } from '@/theme/accessibility';

type Props = {
  /** The field the menu belongs to. */
  anchor: RefObject<ComponentRef<typeof View> | null>;
  onClose: () => void;
  /** The menu's height, to open upwards when there is no room below. */
  height: number;
  children: ReactNode;
};

const GAP = 4;
const ITEMS = '[role="menuitem"], [role="option"], [role="button"], [role="link"], button, a[href], [tabindex="0"]';

const focusables = (root: HTMLElement | null) => Array.from(root?.querySelectorAll<HTMLElement>(ITEMS) ?? []);

/**
 * WEB: a dropdown menu drawn on top of the whole page (31/10/2026). On react-native-web every View is its own layer
 * (z-index 0), so a menu inside a card was covered by the next card or notice, whatever its own z-index. Here it
 * lives at the end of <body>, placed under the field (or above it, near the bottom of the window), and follows it
 * while the page scrolls. A click outside or Esc closes it.
 *
 * Keyboard (01/11/2026, WCAG 2.1.1): being at the end of <body>, the menu was out of the Tab order. Now opening it
 * puts the focus on its first option; the arrows go up and down; Esc and Tab close it, and the focus goes back to
 * the field that opened it (also after choosing an option).
 */
export function Floating({ anchor, onClose, height, children }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    function place() {
      const el = anchor.current as unknown as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const scale = siteScale();
      const onScreen = height * scale;
      const up = window.innerHeight - r.bottom < onScreen + GAP && r.top > window.innerHeight - r.bottom;
      setBox({ top: (up ? r.top - onScreen - GAP : r.bottom + GAP) / scale, left: r.left / scale, width: r.width / scale });
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor, height]);

  // Open: the focus goes to the chosen option (or the first one). Closed: back to the field, unless the person
  // clicked somewhere else on purpose (then the focus is already there).
  const opened = !!box;
  useEffect(() => {
    if (!opened) return;
    const items = focusables(menu.current);
    (items.find((el) => el.getAttribute('aria-selected') === 'true') ?? items[0])?.focus();
    const field = anchor.current as unknown as HTMLElement | null;
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) focusables(field)[0]?.focus() ?? field?.focus();
    };
  }, [opened, anchor]);

  useEffect(() => {
    function outside(e: MouseEvent) {
      const field = anchor.current as unknown as HTMLElement | null;
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !field?.contains(target)) onClose();
    }
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape' || (e.key === 'Tab' && menu.current?.contains(document.activeElement))) {
        if (e.key === 'Tab') e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur();   // the clean-up above gives the focus back to the field
        onClose();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !menu.current?.contains(document.activeElement)) return;
      e.preventDefault();
      const items = focusables(menu.current);
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
        : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [anchor, onClose]);

  if (!box) return null;
  return createPortal(
    <div ref={menu} style={{ position: 'fixed', top: box.top, left: box.left, width: box.width, zIndex: 10000, display: 'flex', flexDirection: 'column' }}>
      {children}
    </div>,
    document.body,
  );
}
