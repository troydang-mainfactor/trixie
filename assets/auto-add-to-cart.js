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
 *
 * Keeps the target item in sync with the trigger condition in both
 * directions: adds it when the trigger becomes satisfied and it's missing,
 * and removes it when the trigger stops being satisfied and it's present.
 * Note: removal is unconditional on the trigger state - if a customer adds
 * the exact same variant themselves as a genuine purchase, it's still
 * removed once the trigger no longer holds, since there's no reliable way
 * to distinguish "we added this" from "the customer added this" without the
 * kind of persistent tracking this feature deliberately avoids.
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

  /**
   * Announces a change on the shared bus so cart-icon, the auto-open drawer,
   * header-actions, cart-items-component, etc. all pick it up exactly like
   * any other cart change. Tagging detail.source lets our own listener above
   * ignore this event instead of re-checking right after we just acted.
   * @param {'add' | 'remove'} action
   * @param {{items: unknown, item_count: number}} cart
   */
  function announceCartChange(action, cart) {
    document.dispatchEvent(
      new CartLinesUpdateEvent({
        action,
        context: action === 'add' ? 'product' : 'cart',
        lines: [{ merchandiseId: config.targetVariantId, quantity: action === 'add' ? 1 : 0 }],
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

  async function addTargetToCart() {
    const response = await fetch(
      Theme.routes.cart_add_url,
      fetchConfig('json', { body: JSON.stringify({ id: config.targetVariantId, quantity: 1 }) })
    );

    if (!response.ok) {
      console.warn('[auto-add-to-cart] Failed to add target item to cart', await response.json().catch(() => null));
      return;
    }

    announceCartChange('add', await fetchCart());
  }

  async function removeTargetFromCart() {
    const response = await fetch(
      Theme.routes.cart_update_url,
      fetchConfig('json', { body: JSON.stringify({ updates: { [config.targetVariantId]: 0 } }) })
    );

    if (!response.ok) {
      console.warn(
        '[auto-add-to-cart] Failed to remove target item from cart',
        await response.json().catch(() => null)
      );
      return;
    }

    announceCartChange('remove', await fetchCart());
  }

  async function runCheck() {
    const cart = await fetchCart();
    const targetPresent = isTargetInCart(cart);
    const triggerSatisfied = shouldTrigger(cart);

    if (triggerSatisfied && !targetPresent) {
      await addTargetToCart();
    } else if (!triggerSatisfied && targetPresent) {
      await removeTargetFromCart();
    }
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
    // Only skip when we can positively confirm this is our own dispatched event
    // (see announceCartChange) - anything else (including a rejected/missing/
    // oddly-shaped promise from a dispatcher we don't fully control) should
    // still trigger a re-check. Checks are cheap and idempotent, so erring
    // toward "check anyway" is safe; erring toward "skip" is what caused the
    // trigger to silently stop firing until the next full page load.
    let isOwnEvent = false;
    try {
      const resolved = await event.promise;
      isOwnEvent = resolved?.detail?.source === SOURCE;
    } catch {
      // Ignore - fall through to scheduleCheck() below.
    }

    if (isOwnEvent) return;

    scheduleCheck();
  });

  // Initial check on page load, in case the trigger condition is already met
  // (e.g. a returning session, or landing directly on the cart page).
  scheduleCheck();
}
