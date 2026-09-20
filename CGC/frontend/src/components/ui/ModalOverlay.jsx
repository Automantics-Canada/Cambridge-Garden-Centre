import { createPortal } from 'react-dom';

/**
 * The full-screen scrim a modal sits on, rendered into `document.body`.
 *
 * The portal is the point. A modal written inline lands inside the dashboard's
 * `<main>`, which is the scrolling region: it starts below the top bar and to
 * the right of the sidebar. `position: fixed` still stretches the scrim across
 * the viewport, so the dimming looked right, but `backdrop-filter` only blurs
 * what is painted inside that scrolling box — the top bar and the sidebar
 * stayed sharp behind a dimmed screen. QA reported it as "the upper area is
 * not showing the blur background".
 *
 * Rendering into the body puts the scrim above the whole layout instead of
 * inside one corner of it.
 */
export default function ModalOverlay({
  children,
  // Arbitrary Tailwind z-index values land in the stylesheet in an order this
  // component cannot control, so a caller that needs to sit above another
  // overlay replaces the class rather than adding a second one.
  zIndexClass = 'z-[100]',
  className = '',
}) {
  return createPortal(
    <div
      className={`fixed inset-0 ${zIndexClass} flex items-center justify-center bg-scrim/50 backdrop-blur-[2px] transition-all ${className}`}
    >
      {children}
    </div>,
    document.body
  );
}
