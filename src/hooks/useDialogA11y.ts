import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The keyboard contract every console panel shares: Escape closes it, Tab cannot walk out of
 * it, focus starts inside on open and goes back to the trigger on close. Without it an
 * operator using a keyboard can tab into the dashboard behind the modal and click Engine
 * Toggle without ever seeing it.
 */
export function useDialogA11y(open: boolean, onClose: () => void, titleId: string) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // onClose is usually an inline arrow with a new identity every render; depending on it would
  // re-run the effect and re-steal focus on every keystroke in the panel.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const origin = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusTimer = window.setTimeout(() => panel?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null
      );
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown, true);
      origin?.focus?.();
    };
  }, [open]);

  return { panelRef, titleId };
}
