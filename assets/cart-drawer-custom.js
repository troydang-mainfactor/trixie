import { lockScroll, unlockScroll } from '@theme/utilities';

/**
 * Horizon's shared <theme-drawer> component intentionally opens non-modally
 * on wide viewports (>= 990px) - no backdrop, no scroll lock, page content
 * stays interactive alongside it ("squeeze" mode). That breakpoint is a
 * private field inside theme-drawer.js, not something a subclass or an
 * external script can override, so instead of editing that shared file this
 * layers true-overlay behavior on top for the cart drawer specifically,
 * regardless of viewport width: a dimmed backdrop (driven by the CSS
 * `body:has(#cart-drawer[open])` rule in cart-drawer-custom.liquid), a
 * locked background scroll, and click-the-backdrop-to-close.
 *
 * lockScroll/unlockScroll are keyed by owner element in a Set, so calling
 * them here alongside theme-drawer.js's own (conditional) calls on the same
 * panel is safe - redundant locks/unlocks for the same owner are no-ops.
 */

const drawer = /** @type {import('./theme-drawer').ThemeDrawer | null} */ (document.getElementById('cart-drawer'));
const backdrop = document.querySelector('[data-cart-drawer-backdrop]');

if (drawer && backdrop) {
  const panel = drawer.querySelector('dialog');

  if (panel) {
    drawer.addEventListener('theme-drawer:open', () => lockScroll(panel));
    drawer.addEventListener('theme-drawer:close', () => unlockScroll(panel));
  }

  backdrop.addEventListener('click', () => {
    drawer.close();
  });
}
