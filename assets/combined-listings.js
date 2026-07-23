import { Component } from '@theme/component';
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
   * @param {Element | null | undefined} productCard
   * @param {string} title
   */
  #swapTitle(productCard, title) {
    if (!title) return;
    const titleLink = productCard?.querySelector('[ref="productTitleLink"]');
    if (!titleLink) return;

    const target = titleLink.querySelector('[role="heading"]') ?? titleLink.querySelector(':scope > *') ?? titleLink;
    target.textContent = title;
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
