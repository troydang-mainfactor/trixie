import { Component } from '@theme/component';
import { requestIdleCallback } from '@theme/utilities';
import { ProductSelectEvent } from '@shopify/events';

/**
 * Shared tooltip behavior for the Combined Listings swatch pickers.
 * Tooltips are rendered via the native Popover API (`popover="manual"`) so they escape
 * ancestor `overflow: hidden` (product cards clip their gallery) and always sit in the
 * top layer. Position is computed here rather than via CSS anchor positioning for
 * broader browser support, since the requirement is a simple point-relative offset.
 *
 * @extends {Component}
 */
class CombinedListingsBase extends Component {
  /** @param {Event} event */
  showTooltip(event) {
    const trigger = /** @type {HTMLElement} */ (event.target);
    const tooltip = this.#tooltipFor(trigger);
    if (!tooltip) return;

    const rect = trigger.getBoundingClientRect();
    tooltip.style.setProperty('--cl-tooltip-anchor-top', `${rect.bottom + 8}`);
    tooltip.style.setProperty('--cl-tooltip-anchor-left', `${rect.left}`);

    if (!tooltip.matches(':popover-open')) {
      try {
        tooltip.showPopover();
      } catch {
        // Already open or not supported; ignore.
      }
    }
  }

  /** @param {PointerEvent | FocusEvent} event */
  hideTooltip(event) {
    // Touch devices fire pointerleave immediately after the tap that opened the tooltip
    // (there is no hover state to leave); keep it open until an outside tap or blur closes it.
    if (/** @type {PointerEvent} */ (event).pointerType === 'touch') return;

    const trigger = /** @type {HTMLElement} */ (event.target);
    const tooltip = this.#tooltipFor(trigger);
    if (!tooltip) return;

    if (tooltip.matches(':popover-open')) {
      try {
        tooltip.hidePopover();
      } catch {
        // Already closed; ignore.
      }
    }
  }

  /**
   * @param {HTMLElement} trigger
   * @returns {HTMLElement | null}
   */
  #tooltipFor(trigger) {
    const id = trigger.getAttribute('aria-describedby');
    if (!id) return null;

    return document.getElementById(id);
  }

  #dismissOnOutsideTap = (/** @type {PointerEvent} */ event) => {
    if (event.target instanceof Node && this.contains(event.target)) return;

    for (const tooltip of this.querySelectorAll(':popover-open')) {
      /** @type {any} */ (tooltip).hidePopover?.();
    }
  };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('pointerdown', this.#dismissOnOutsideTap);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('pointerdown', this.#dismissOnOutsideTap);
  }
}

/**
 * Combined Listings - Product Page.
 * Navigating swatches: each links to a different product. Appends the shopper's currently
 * selected non-color option (e.g. Size) to each swatch link so it can be restored on the
 * destination product, and restores it from the URL on load.
 *
 * @typedef {object} Refs
 * @property {HTMLAnchorElement[]} [swatchTriggers]
 * @property {HTMLElement[]} [swatchLabels] - Per-swatch tag-text label, index-aligned with swatchTriggers.
 * @property {HTMLElement} [tagRules] - Hidden container of tag-text rule data emitted by each
 *   _combined-listings-tag-text block.
 * @extends {CombinedListingsBase}
 */
class CombinedListingsPicker extends CombinedListingsBase {
  /** @type {import('./variant-picker').default | null} */
  #variantPicker = null;

  connectedCallback() {
    super.connectedCallback();

    const triggers = this.refs.swatchTriggers ?? [];
    for (const trigger of triggers) {
      if (trigger instanceof HTMLAnchorElement) trigger.dataset.baseHref = trigger.href;
    }

    this.#variantPicker = document.querySelector('variant-picker[data-template-product-match="true"]');
    this.#variantPicker?.addEventListener('change', this.#syncHrefs);
    this.#syncHrefs();
    this.#restoreOptionFromUrl();
    this.#showPerSwatchTagText();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#variantPicker?.removeEventListener('change', this.#syncHrefs);
  }

  /** @param {Event} event */
  handleSwatchClick(event) {
    const trigger = /** @type {HTMLElement} */ (event.target);
    if (trigger.getAttribute('aria-current') === 'true') event.preventDefault();
  }

  /**
   * Appends the shopper's currently selected options (e.g. Size) to every swatch link,
   * so the destination product can preselect the same option on load.
   */
  #syncHrefs = () => {
    const selectedOptions = this.#variantPicker?.getAllSelectedOptions?.() ?? [];
    const triggers = this.refs.swatchTriggers ?? [];

    for (const trigger of triggers) {
      if (!(trigger instanceof HTMLAnchorElement) || !trigger.dataset.baseHref) continue;

      const url = new URL(trigger.dataset.baseHref, window.location.origin);
      for (const { name, value } of selectedOptions) {
        if (name && value) url.searchParams.set(name, value);
      }
      trigger.href = `${url.pathname}${url.search}`;
    }
  };

  /**
   * On load, checks the URL for an option carried over from a swatch link on another
   * product (e.g. ?Size=Medium) and preselects it if this product has a matching value.
   * Falls back silently to the default selected variant when there is no match.
   */
  #restoreOptionFromUrl() {
    const variantPicker = this.#variantPicker;
    if (!variantPicker) return;

    const params = new URLSearchParams(window.location.search);
    const inputs = variantPicker.querySelectorAll('input[data-option-name]');

    for (const input of inputs) {
      if (!(input instanceof HTMLInputElement)) continue;

      const name = input.dataset.optionName;
      if (!name || !params.has(name)) continue;
      if (input.value !== params.get(name) || input.checked) continue;

      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  /**
   * Shows the first tag-text rule (in block order) whose tag matches EACH swatch's OWN
   * linked product — independent of which product in the group is currently being viewed,
   * so the same swatch shows the same label on every listing in the group. Matching happens
   * here rather than in Liquid, since a block's nested block settings aren't reliably
   * readable server-side from a shared snippet.
   */
  #showPerSwatchTagText() {
    const { swatchTriggers, swatchLabels, tagRules } = this.refs;
    if (!swatchTriggers || !swatchLabels || !tagRules) return;

    const rules = /** @type {HTMLElement[]} */ (Array.from(tagRules.querySelectorAll('[data-cl-tag-rule]')));
    if (!rules.length) return;

    swatchTriggers.forEach((trigger, index) => {
      const label = swatchLabels[index];
      if (!label) return;

      const productTags = (trigger.dataset.productTags ?? '').split(',').filter(Boolean);
      if (!productTags.length) return;

      const rule = rules.find((el) => el.dataset.tag && productTags.includes(el.dataset.tag));
      if (!rule) return;

      label.textContent = rule.textContent;
      label.hidden = false;
    });
  }
}

if (!customElements.get('combined-listings-picker')) {
  customElements.define('combined-listings-picker', CombinedListingsPicker);
}

/**
 * Combined Listings - Product Card.
 * Swapping (non-navigating) swatches: clicking one swaps the card's image, title, links,
 * and quick-add target to the swatch's linked product, without leaving the grid.
 *
 * @typedef {object} Refs
 * @property {HTMLButtonElement[]} [swatchTriggers]
 * @extends {CombinedListingsBase}
 */
class CombinedListingsCardSwatches extends CombinedListingsBase {
  connectedCallback() {
    super.connectedCallback();
    // Each swatch's target image sits inert inside a <template>, so the browser never fetches
    // it until cloned into the document — the click handler would otherwise trigger a cold
    // fetch + decode right when the shopper expects an instant swap. Warm the cache ahead of
    // time instead, off the critical rendering path.
    requestIdleCallback(() => this.#prefetchSwatchImages());
  }

  #prefetchSwatchImages() {
    const templates = this.querySelectorAll('template[data-cl-swap-image]');
    for (const template of templates) {
      const img = /** @type {HTMLTemplateElement} */ (template).content.querySelector('img');
      if (!(img instanceof HTMLImageElement) || !img.src) continue;

      const preload = new Image();
      preload.srcset = img.srcset;
      preload.sizes = img.sizes;
      preload.src = img.src;
    }
  }

  /** @param {Event} event */
  selectSwatch(event) {
    const trigger = /** @type {HTMLButtonElement} */ (event.target);
    if (trigger.getAttribute('aria-pressed') === 'true') return;

    for (const other of this.refs.swatchTriggers ?? []) {
      other.setAttribute('aria-pressed', other === trigger ? 'true' : 'false');
      other.classList.toggle('cl-swatch-trigger--active', other === trigger);
    }

    const { productId, productTitle, productUrl, productAvailable, quickAddMode, quickAddVariantId } = trigger.dataset;
    if (!productUrl) return;

    const productCard = /** @type {import('./product-card').ProductCard | null} */ (this.closest('product-card'));

    productCard?.applyVariantToLinks(null, productUrl);
    this.#swapImage(trigger);
    this.#swapTitle(productCard, productTitle ?? '');
    this.#syncQuickAdd(productCard, {
      productId: productId ?? '',
      productTitle: productTitle ?? '',
      quickAddMode: quickAddMode ?? 'choose',
      quickAddVariantId: quickAddVariantId ?? '',
      available: productAvailable !== 'false',
    });
    this.#syncBuyButtons(productCard, {
      productId: productId ?? '',
      quickAddVariantId: quickAddVariantId ?? '',
      available: productAvailable !== 'false',
    });

    this.#dispatchAnalyticsEvent({ productId: productId ?? '', productTitle: productTitle ?? '', productUrl });
  }

  /** @param {HTMLElement} trigger */
  #swapImage(trigger) {
    const template = trigger.closest('li')?.querySelector('template[data-cl-swap-image]');
    const newImage = /** @type {HTMLTemplateElement | undefined} */ (template)?.content.querySelector('img');
    const productCard = this.closest('product-card');
    const currentImage = productCard?.querySelector('.card-gallery img');
    if (!(newImage instanceof HTMLImageElement) || !(currentImage instanceof HTMLImageElement)) return;

    currentImage.src = newImage.src;
    currentImage.srcset = newImage.srcset;
    currentImage.sizes = newImage.sizes;
    currentImage.alt = newImage.alt;

    /** @type {any} */ (productCard?.refs)?.slideshow?.select?.(0, undefined, { animate: false });
  }

  /**
   * Mirrors the " - " split done in blocks/product-title.liquid, so a swapped-in title gets
   * the same smaller-subtitle-on-its-own-line treatment. Builds the DOM directly (not innerHTML)
   * since the title is untrusted text read back from a data attribute.
   * @param {Element | null | undefined} productCard
   * @param {string} title
   */
  #swapTitle(productCard, title) {
    if (!title) return;
    const titleLink = productCard?.querySelector('[ref="productTitleLink"]');
    if (!titleLink) return;

    const target = titleLink.querySelector('[role="heading"]') ?? titleLink.querySelector(':scope > *') ?? titleLink;
    const [firstLine, ...rest] = title.split(' - ');

    target.replaceChildren(document.createTextNode(firstLine ?? title));

    if (rest.length) {
      const subtitle = document.createElement('span');
      subtitle.className = 'product-title__subtitle';
      subtitle.textContent = rest.join(' - ');
      target.append(subtitle);
    }
  }

  /**
   * Keeps quick add pointed at the currently selected swatch's product/variant, since it
   * otherwise defaults back to the card's original product (a separate component's state).
   * @param {Element | null | undefined} productCard
   * @param {{productId: string, productTitle: string, quickAddMode: string, quickAddVariantId: string, available: boolean}} target
   */
  #syncQuickAdd(productCard, { productId, productTitle, quickAddMode, quickAddVariantId, available }) {
    const quickAdd = productCard?.querySelector('quick-add-component');
    if (!(quickAdd instanceof HTMLElement)) return;

    quickAdd.dataset.productId = productId;
    quickAdd.dataset.productTitle = productTitle;

    const mode = available && quickAddMode === 'add' ? 'add' : 'choose';
    quickAdd.setAttribute('data-quick-add-button', mode);

    const variantInput = quickAdd.querySelector('input[name="id"]');
    if (variantInput instanceof HTMLInputElement) {
      variantInput.value = quickAddVariantId;
      variantInput.disabled = !available || !quickAddVariantId;
    }
  }

  /**
   * Keeps the buy-buttons block's add-to-cart form pointed at the currently selected swatch's
   * product/variant. Unlike the normal variant-picker flow, this swap never triggers the server
   * round trip that would otherwise sync the form, so without this the button keeps submitting
   * whichever product the card originally rendered with.
   * @param {Element | null | undefined} productCard
   * @param {{productId: string, quickAddVariantId: string, available: boolean}} target
   */
  #syncBuyButtons(productCard, { productId, quickAddVariantId, available }) {
    // Scoped to .buy-buttons-block: quick-add-component renders its own separate
    // product-form-component earlier in the card for its "Add" flow, and an unscoped
    // lookup would match that one instead of the visible buy-buttons block's form.
    const productForm = productCard?.querySelector('.buy-buttons-block product-form-component');
    if (!(productForm instanceof HTMLElement)) return;

    productForm.dataset.productId = productId;

    const variantInput = productForm.querySelector('[ref="variantId"]');
    const canAddToCart = available && !!quickAddVariantId;
    if (variantInput instanceof HTMLInputElement) {
      variantInput.value = canAddToCart ? quickAddVariantId : '';
    }

    const addToCart = productForm.querySelector('add-to-cart-component');
    if (addToCart instanceof HTMLElement && 'disable' in addToCart && 'enable' in addToCart) {
      /** @type {any} */ (addToCart)[canAddToCart ? 'enable' : 'disable']();
    }
  }

  /**
   * Fires the theme's standard product-select event so existing analytics listeners see this
   * client-side swap (it otherwise generates no page view or navigation to hook into).
   * @param {{productId: string, productTitle: string, productUrl?: string}} detail
   */
  #dispatchAnalyticsEvent({ productId, productTitle, productUrl }) {
    const deferred = ProductSelectEvent.createPromise();

    this.dispatchEvent(
      new ProductSelectEvent({
        product: { id: productId, title: productTitle, handle: '' },
        selectedOptions: [],
        detail: { optionValueId: '', variantId: '', connectedProductUrl: productUrl ?? '' },
        promise: deferred.promise,
      })
    );

    queueMicrotask(() => deferred.resolve({ variant: null, detail: {} }));
  }
}

if (!customElements.get('combined-listings-card-swatches')) {
  customElements.define('combined-listings-card-swatches', CombinedListingsCardSwatches);
}
