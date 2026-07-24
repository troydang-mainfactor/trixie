import { Component } from '@theme/component';
import { mediaQueryLarge, prefersReducedMotion } from '@theme/utilities';

/** Layout styles that stay accordion-semantics at every width - only their visual layout changes. */
const ALWAYS_ACCORDION_STYLES = ['1', '7'];

/**
 * @typedef {Object} PremiumProductInfoRefs
 * @property {HTMLElement} tablist
 * @property {HTMLElement} itemsWrapper
 * @property {HTMLElement[]} itemHeadings
 * @property {HTMLElement[]} itemPanels
 */

/**
 * Tabs (desktop) / accordion (mobile) - one server-rendered DOM tree, no duplicate markup.
 * Progressive enhancement: the Liquid template renders plain `<h3>` headings and always-visible
 * panels (readable with JS disabled); this component upgrades each heading's content into a real
 * `<button>` trigger and applies the correct ARIA semantics for the current layout style and
 * breakpoint, re-deriving them (not duplicating content) whenever either changes.
 *
 * @extends {Component<PremiumProductInfoRefs>}
 */
class PremiumProductInfo extends Component {
  requiredRefs = ['tablist', 'itemsWrapper'];

  /** @type {HTMLButtonElement[]} */
  #triggers = [];

  /** @type {'tabs' | 'accordion' | undefined} */
  #mode;

  /** @type {AbortController} */
  #controller = new AbortController();

  /** @type {ResizeObserver | undefined} */
  #resizeObserver;

  get #layoutStyle() {
    return this.dataset.layoutStyle ?? '2';
  }

  get #alwaysAccordion() {
    return ALWAYS_ACCORDION_STYLES.includes(this.#layoutStyle);
  }

  get #allowMultipleOpen() {
    return this.dataset.multipleOpen === 'true';
  }

  connectedCallback() {
    super.connectedCallback();
    const { signal } = this.#controller;

    this.#upgradeHeadings();
    this.#applySemantics({ initial: true });

    if (!this.#alwaysAccordion) {
      mediaQueryLarge.addEventListener('change', () => this.#applySemantics({ initial: false }), { signal });
    }

    if (this.#layoutStyle === '2' || this.#layoutStyle === '4') {
      this.#resizeObserver = new ResizeObserver(() => this.#updateIndicator());
      this.#resizeObserver.observe(this.refs.tablist);
    }

    document.addEventListener('shopify:block:select', this.#handleBlockSelect, { signal });
  }

  disconnectedCallback() {
    this.#controller.abort();
    this.#resizeObserver?.disconnect();
  }

  /**
   * The Section Rendering API can morph this element's existing subtree in place (editor saves,
   * some app embeds) rather than replacing the whole custom element - `Component` calls this when
   * that happens (a full replace just re-triggers `connectedCallback` naturally instead). Either
   * way, block content may have changed under us, so re-run the same upgrade + semantics pass.
   */
  updatedCallback() {
    super.updatedCallback();
    this.#upgradeHeadings();
    this.#applySemantics({ initial: true });
  }

  #handleBlockSelect = (event) => {
    const target = /** @type {CustomEvent<{ blockId?: string }>} */ (event);
    const blockId = target.detail?.blockId;
    const trigger = this.#triggers.find((t) => t.dataset.blockId === blockId);
    if (!trigger || !this.contains(trigger)) return;

    if (this.#mode === 'tabs') {
      this.#activateTab(trigger, { animate: false });
    } else {
      this.#expandAccordionItem(trigger, { animate: false });
    }
    trigger.scrollIntoView({ block: 'nearest' });
  };

  /**
   * Replaces each server-rendered `<h3>` heading's plain content with a real interactive
   * `<button>` wrapping that same content - the no-JS reader saw a heading, the enhanced reader
   * gets a fully accessible trigger. Idempotent: safe to call again after a Section Rendering
   * API re-render replaces the headings.
   */
  #upgradeHeadings() {
    const { itemHeadings } = this.refs;
    if (!itemHeadings?.length) return;

    this.#triggers = itemHeadings.map((heading) => {
      const existing = heading.querySelector(':scope > button.ppi-item__trigger');
      if (existing instanceof HTMLButtonElement) return existing;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ppi-item__trigger';
      button.id = heading.id;
      button.dataset.panelId = heading.dataset.panelId ?? '';
      button.dataset.blockId = heading.dataset.blockId ?? '';
      button.setAttribute('on:click', '/handleTriggerClick');
      button.append(...heading.childNodes);

      heading.removeAttribute('id');
      heading.append(button);

      return button;
    });
  }

  /**
   * Derives the correct semantic mode for the current layout style + breakpoint and applies it.
   * Safe to call repeatedly (breakpoint changes, editor re-selects) - it's a no-op re-apply when
   * the mode hasn't changed, and a full re-derivation (not a content re-render) when it has.
   *
   * @param {{ initial: boolean }} options
   */
  #applySemantics({ initial }) {
    const targetMode = this.#alwaysAccordion || !mediaQueryLarge.matches ? 'accordion' : 'tabs';
    if (!initial && targetMode === this.#mode) return;

    const previousMode = this.#mode;
    this.#mode = targetMode;
    this.dataset.mode = targetMode;

    if (targetMode === 'tabs') {
      this.#enterTabsMode({ preservePreviousAccordionState: previousMode === 'accordion' });
    } else {
      this.#enterAccordionMode({ initial, preservePreviousTab: previousMode === 'tabs' });
    }
  }

  #enterTabsMode({ preservePreviousAccordionState }) {
    const { tablist } = this.refs;
    tablist.hidden = false;
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-orientation', this.#layoutStyle === '6' ? 'vertical' : 'horizontal');

    let activeTrigger = preservePreviousAccordionState
      ? this.#triggers.find((t) => t.getAttribute('aria-expanded') === 'true')
      : this.#triggers.find((t) => t.getAttribute('aria-selected') === 'true');
    if (!activeTrigger) activeTrigger = this.#triggers[0];

    this.#triggers.forEach((trigger) => {
      tablist.append(trigger); // real DOM move - keeps role="tablist" a genuine parent/child relationship
      trigger.setAttribute('role', 'tab');
      trigger.removeAttribute('aria-expanded');
      const panel = this.#panelFor(trigger);
      panel?.removeAttribute('data-expanded');
      panel?.removeAttribute('inert');
      panel?.setAttribute('role', 'tabpanel');
      panel?.setAttribute('aria-labelledby', trigger.id);
    });

    if (activeTrigger) this.#activateTab(activeTrigger, { animate: false });
  }

  #enterAccordionMode({ initial, preservePreviousTab }) {
    const { tablist } = this.refs;
    tablist.hidden = true;
    tablist.removeAttribute('role');
    tablist.removeAttribute('aria-orientation');

    this.#triggers.forEach((trigger) => {
      const panelId = trigger.dataset.panelId;
      const panel = panelId ? document.getElementById(panelId) : null;
      const heading = panel?.previousElementSibling; // `.ppi-item__heading`, adjacent to its panel in source order
      heading?.append(trigger); // move back next to its own panel, restoring the no-JS reading order

      trigger.removeAttribute('role');
      trigger.removeAttribute('aria-selected');
      trigger.removeAttribute('tabindex');
      panel?.removeAttribute('role');
      panel?.removeAttribute('aria-labelledby');
      panel?.removeAttribute('hidden');
    });

    if (initial) {
      const state = this.dataset.mobileDefault ?? 'first_open';
      this.#triggers.forEach((trigger, index) => {
        const shouldOpen = state === 'all_open' || (state === 'first_open' && index === 0);
        this.#setAccordionItemState(trigger, shouldOpen, { animate: false });
      });
      return;
    }

    if (preservePreviousTab) {
      const activeTrigger = this.#triggers.find((t) => t.getAttribute('aria-selected') === 'true');
      this.#triggers.forEach((trigger) => {
        this.#setAccordionItemState(trigger, trigger === activeTrigger, { animate: false });
      });
    }
  }

  /**
   * Handles a click on any item trigger, in either presentation.
   * @param {PointerEvent} event
   */
  handleTriggerClick = (event) => {
    const trigger = /** @type {Element} */ (event.target).closest('.ppi-item__trigger');
    if (!(trigger instanceof HTMLButtonElement)) return;

    if (this.#mode === 'tabs') {
      this.#activateTab(trigger, { animate: true });
    } else {
      this.#toggleAccordionItem(trigger);
    }
  };

  /**
   * Arrow-key/Home/End navigation between tabs. Wired declaratively via `on:keydown` on the
   * tablist in Liquid; inert in accordion mode since the tablist is hidden there and native
   * `<button>` already handles Enter/Space activation for accordion triggers.
   * @param {KeyboardEvent} event
   */
  handleTablistKeydown = (event) => {
    if (this.#mode !== 'tabs' || !this.#triggers.length) return;

    const currentIndex = this.#triggers.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    if (currentIndex === -1) return;

    const vertical = this.#layoutStyle === '6';
    const nextKey = vertical ? 'ArrowDown' : 'ArrowRight';
    const prevKey = vertical ? 'ArrowUp' : 'ArrowLeft';

    let nextIndex;
    switch (event.key) {
      case nextKey:
        nextIndex = (currentIndex + 1) % this.#triggers.length;
        break;
      case prevKey:
        nextIndex = (currentIndex - 1 + this.#triggers.length) % this.#triggers.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = this.#triggers.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextTrigger = this.#triggers[nextIndex];
    nextTrigger.focus();
    this.#activateTab(nextTrigger, { animate: true });
  };

  /**
   * @param {HTMLButtonElement} trigger
   * @param {{ animate: boolean }} options
   */
  #activateTab(trigger, { animate }) {
    this.#triggers.forEach((t) => {
      const isActive = t === trigger;
      t.setAttribute('aria-selected', String(isActive));
      t.setAttribute('tabindex', isActive ? '0' : '-1');
      this.#panelFor(t)?.toggleAttribute('hidden', !isActive);
    });

    if (this.#layoutStyle === '2' || this.#layoutStyle === '4') {
      if (animate) this.#updateIndicator();
      else requestAnimationFrame(() => this.#updateIndicator());
    }

    this.dispatchEvent(
      new CustomEvent('premium-product-info:change', {
        bubbles: true,
        detail: { blockId: trigger.dataset.blockId, presentation: 'tab' },
      })
    );
  }

  /** @param {HTMLButtonElement} trigger */
  #toggleAccordionItem(trigger) {
    const expanded = trigger.getAttribute('aria-expanded') === 'true';

    if (!expanded && !this.#allowMultipleOpen) {
      this.#triggers.forEach((t) => {
        if (t !== trigger) this.#setAccordionItemState(t, false, { animate: true });
      });
    }

    this.#setAccordionItemState(trigger, !expanded, { animate: true });

    this.dispatchEvent(
      new CustomEvent('premium-product-info:change', {
        bubbles: true,
        detail: { blockId: trigger.dataset.blockId, presentation: 'accordion' },
      })
    );
  }

  /**
   * @param {HTMLButtonElement} trigger
   * @param {boolean} expand
   * @param {{ animate: boolean }} options
   */
  #expandAccordionItem(trigger, options) {
    if (!this.#allowMultipleOpen) {
      this.#triggers.forEach((t) => {
        if (t !== trigger) this.#setAccordionItemState(t, false, options);
      });
    }
    this.#setAccordionItemState(trigger, true, options);
  }

  /**
   * @param {HTMLButtonElement} trigger
   * @param {boolean} expand
   * @param {{ animate: boolean }} options
   */
  #setAccordionItemState(trigger, expand, { animate }) {
    trigger.setAttribute('aria-expanded', String(expand));
    const panel = this.#panelFor(trigger);
    if (!panel) return;

    panel.toggleAttribute('inert', !expand);
    if (!animate || prefersReducedMotion()) {
      panel.dataset.expanded = String(expand);
      panel.dataset.skipTransition = 'true';
      requestAnimationFrame(() => delete panel.dataset.skipTransition);
    } else {
      panel.dataset.expanded = String(expand);
    }
  }

  /** @param {HTMLButtonElement} trigger */
  #panelFor(trigger) {
    const id = trigger.dataset.panelId;
    return id ? document.getElementById(id) : null;
  }

  /** Positions the sliding underline (style 2) / segmented thumb (style 4) under the active tab. */
  #updateIndicator() {
    const active = this.#triggers.find((t) => t.getAttribute('aria-selected') === 'true');
    if (!active) return;

    const { tablist } = this.refs;
    const tablistRect = tablist.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();

    tablist.style.setProperty('--ppi-indicator-x', `${activeRect.left - tablistRect.left}px`);
    tablist.style.setProperty('--ppi-indicator-width', `${activeRect.width}px`);
  }
}

if (!customElements.get('premium-product-info')) {
  customElements.define('premium-product-info', PremiumProductInfo);
}
