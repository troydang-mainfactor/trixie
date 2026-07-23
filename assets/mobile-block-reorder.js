import { mediaQueryLarge } from '@theme/utilities';

/**
 * Moves an element marked `data-mobile-above-media="true"` to just before the product page's
 * media gallery on mobile, and back to its original position on desktop. Used by the "Show
 * above media on mobile" group block setting, so a single block (e.g. a renamed "Header" group)
 * can sit above the gallery on mobile without reordering the whole product-details column.
 *
 * A comment node left in the block's original slot acts as a permanent anchor so the move is
 * reversible any number of times across resizes, instead of only working once.
 *
 * @param {HTMLElement} el
 */
function setUpMobileReorder(el) {
  const media = el.closest('product-component')?.querySelector('.product-information__media');
  if (!media) return;

  const anchor = document.createComment('mobile-above-media-anchor');
  el.after(anchor);

  const apply = () => {
    if (mediaQueryLarge.matches) {
      if (el.previousSibling !== anchor) anchor.after(el);
    } else if (el.nextElementSibling !== media) {
      media.before(el);
    }
  };

  apply();
  mediaQueryLarge.addEventListener('change', apply);
}

document.querySelectorAll('[data-mobile-above-media="true"]').forEach((el) => {
  if (el instanceof HTMLElement) setUpMobileReorder(el);
});
