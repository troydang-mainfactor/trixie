import { fetchConfig } from '@theme/utilities';
import { CartLinesUpdateEvent, StandardEvents } from '@shopify/events';

/**
 * Only loaded when sections/auto-add-to-cart.liquid renders its config + this
 * script tag (merchant has enabled the feature and configured a target item).
 *
 * Listens on the theme's single cart-lines-update event bus, which every
 * cart-mutating surface in Horizon (product-form add-to-cart, quick add,
 * sticky add-to-cart, and cart-items-component quantity/remove - both drawer
 * and /cart page) already dispatches through, so one listener here covers all
 * of them without touching any of those files.
 */

const SOURCE = 'auto-add-to-cart';

const configElement = document.getElementById('auto-add-to-cart-config');
const config = configElement ? JSON.parse(configElement.textContent) : null;

if (config && config.targetVariantId) {
  /** Guards against overlapping checks - see scheduleCheck. */
  let checkInFlight = false;
  let recheckQueued = false;

  async function fetchCart() {
    const response = await fetch(`${Theme.routes.cart_url}.json`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });

    if (!response.ok) throw new Error(`Failed to fetch cart: ${response.status}`);
    return response.json();
  }

  /** @param {{items: Array<{variant_id: number, product_id: number}>}} cart */
  function isTargetInCart(cart) {
    return cart.items.some((item) => String(item.variant_id) === String(config.targetVariantId));
  }

  /** @param {{items: Array<{product_id: number}>, total_price: number}} cart */
  function shouldTrigger(cart) {
    if (config.triggerType === 'subtotal') {
      return cart.total_price >= config.subtotalThresholdCents;
    }

    if (config.triggerType === 'cart_contains') {
      if (config.cartContainsType === 'product' && config.cartContainsProductId) {
        return cart.items.some((item) => String(item.product_id) === String(config.cartContainsProductId));
      }

      if (config.cartContainsType === 'collection' && config.cartContainsCollectionProductIds?.length) {
        const collectionProductIds = config.cartContainsCollectionProductIds.map(String);
        return cart.items.some((item) => collectionProductIds.includes(String(item.product_id)));
      }
    }

    return false;
  }

  async function addTargetToCart() {
    const response = await fetch(
      Theme.routes.cart_add_url,
      fetchConfig('json', { body: JSON.stringify({ id: config.targetVariantId, quantity: 1 }) })
    );

    if (!response.ok) {
      console.warn('[auto-add-to-cart] Failed to add target item to cart', await response.json().catch(() => null));
      return;
    }

    const cart = await fetchCart();

    // Announce the change on the shared bus so cart-icon, the auto-open drawer,
    // header-actions, etc. all pick it up exactly like any other cart change.
    // Tagging detail.source lets our own listener below ignore this event.
    document.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'product',
        lines: [{ merchandiseId: config.targetVariantId, quantity: 1 }],
        promise: Promise.resolve({
          cart,
          detail: {
            source: SOURCE,
            items: cart.items,
            itemCount: cart.item_count,
            didError: false,
          },
        }),
      })
    );
  }

  async function runCheck() {
    const cart = await fetchCart();
    if (isTargetInCart(cart)) return;
    if (!shouldTrigger(cart)) return;
    await addTargetToCart();
  }

  /**
   * Runs one check, queuing at most one follow-up re-check if another trigger
   * fires while a check/add is already in flight - avoids ever starting a
   * second /cart/add.js call before the first one has resolved.
   */
  async function scheduleCheck() {
    if (checkInFlight) {
      recheckQueued = true;
      return;
    }

    checkInFlight = true;
    try {
      await runCheck();
    } catch (error) {
      console.warn('[auto-add-to-cart] Trigger check failed', error);
    } finally {
      checkInFlight = false;
      if (recheckQueued) {
        recheckQueued = false;
        scheduleCheck();
      }
    }
  }

  document.addEventListener(StandardEvents.cartLinesUpdate, async (event) => {
    /** @type {{source?: string} | undefined} */
    let detail;
    try {
      ({ detail } = await event.promise);
    } catch {
      // The mutation that triggered this event failed - cart state is unchanged.
      return;
    }

    // Ignore our own dispatched event (see addTargetToCart) to avoid re-checking
    // immediately after we just added the item ourselves.
    if (detail?.source === SOURCE) return;

    scheduleCheck();
  });

  // Initial check on page load, in case the trigger condition is already met
  // (e.g. a returning session, or landing directly on the cart page).
  scheduleCheck();
}
