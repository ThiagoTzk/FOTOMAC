/**
 * Keyboard support for the whole site (01/11/2026, WCAG 2.1.1 and 2.4.3), found by going through every page with the
 * Tab key only. Two gaps of React Native for Web, closed here once instead of in each screen:
 *
 * 1. Enter on a link did nothing. Its links are <div role="link"> (no href) and it leaves Enter to the browser,
 *    which only follows real <a href>. Here Enter on such a link clicks it, as a mouse would.
 * 2. Tab left an open dialog and wandered through the page behind it. Here, while a window (aria-modal) is open,
 *    Tab and Shift+Tab go round its own buttons and fields.
 * 3. Space did nothing on switches and check boxes drawn as <div role="switch|checkbox|radio"> (it only presses
 *    "button" roles), and Space is the key of a switch. Here it presses them, without scrolling the page.
 */
import { Platform } from 'react-native';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function fakeLink(el: EventTarget | null): el is HTMLElement {
  return el instanceof HTMLElement && el.getAttribute('role') === 'link' && !(el instanceof HTMLAnchorElement && el.href)
    && el.getAttribute('aria-disabled') !== 'true';
}

const TOGGLES = ['switch', 'checkbox', 'radio'];
function fakeToggle(el: EventTarget | null): el is HTMLElement {
  return el instanceof HTMLElement && !(el instanceof HTMLInputElement) && TOGGLES.includes(el.getAttribute('role') ?? '')
    && el.getAttribute('aria-disabled') !== 'true';
}

function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

export function installKeyboard(): void {
  if (Platform.OS !== 'web' || (window as any).__fotomacKeyboard) return;
  (window as any).__fotomacKeyboard = true;

  // Capture phase: React for Web stops the key events of its pressables before they reach the document.
  let pressed: HTMLElement | null = null;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.repeat && fakeLink(e.target)) pressed = e.target;
    if (e.key === ' ' && fakeToggle(e.target)) {
      e.preventDefault();   // no page scroll
      if (!e.repeat) pressed = e.target;
    }
    if (e.key === 'Tab') trap(e);
  }, true);
  document.addEventListener('keyup', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && pressed && e.target === pressed) pressed.click();
    pressed = null;
  }, true);
}

function trap(e: KeyboardEvent): void {
  const dialogs = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
  const dialog = dialogs[dialogs.length - 1];   // the innermost / latest window
  if (!dialog) return;
  const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1], active = document.activeElement;
  if (!dialog.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
