import { Component } from '@theme/component';
import { mediaQueryLarge, isDesktopBreakpoint, prefersReducedMotion } from '@theme/utilities';
import { ProductInfoTabSelectEvent } from '@theme/events';

/**
 * @typedef {Object} ProductInfoRefs
 * @property {HTMLElement} tablist - Empty on mobile; holds the moved trigger buttons on desktop.
 * @property {HTMLElement} accordionWrapper - Holds every `.product-info-tab` row, in source order.
 * @property {HTMLElement[]} triggers - One button per qualifying `tab-item` block.
 * @property {HTMLElement[]} panels - One panel per qualifying `tab-item` block (index-matched to triggers).
 */

/**
 * Horizontal tabs on desktop, accordion on mobile - same underlying `tab-item` block markup for
 * both. The breakpoint switch re-parents each trigger button between its own row's heading slot
 * (accordion) and the shared tablist container (tabs), rather than duplicating any markup, so
 * `role="tablist"`/`role="tab"` stays a real DOM relationship (not just a visual one) for
 * assistive tech, while `aria-controls`/`aria-labelledby` (already set in Liquid) keep pointing
 * at the right panel/trigger regardless of which container the trigger currently lives in.
 *
 * @extends {Component<ProductInfoRefs>}
 */
class ProductInfoTabs extends Component {
  requiredRefs = ['accordionWrapper'];

  /** @type {AbortController} */
  #controller = new AbortController();

  /** @type {string | undefined} */
  #activeBlockId;

  /** @type {Animation | undefined} */
  #animation;

  connectedCallback() {
    super.connectedCallback();
    const { signal } = this.#controller;

    mediaQueryLarge.addEventListener('change', this.#handleBreakpointChange, { signal });
    this.#applyLayout({ animate: false });
  }

  disconnectedCallback() {
    this.#controller.abort();
    this.#animation?.cancel();
  }

  #handleBreakpointChange = () => {
    this.#applyLayout({ animate: false });
  };

  /**
   * Re-derives tab vs. accordion presentation for the current breakpoint. Safe to call
   * repeatedly (e.g. on every resize past the breakpoint) - it's idempotent per layout.
   *
   * @param {{ animate: boolean }} options
   */
  #applyLayout({ animate }) {
    const { triggers, panels, tablist, accordionWrapper } = this.refs;
    if (!triggers?.length || !panels?.length) return;

    const desktop = isDesktopBreakpoint();
    const focused = /** @type {HTMLElement | null} */ (document.activeElement);

    if (desktop) {
      if (!this.#activeBlockId) {
        this.#activeBlockId = this.#blockIdFor(triggers[0]);
      }

      triggers.forEach((trigger) => {
        tablist?.append(trigger);
        trigger.setAttribute('role', 'tab');
        trigger.removeAttribute('aria-expanded');
      });
      if (tablist) tablist.hidden = false;

      panels.forEach((panel) => {
        panel.setAttribute('role', 'tabpanel');
      });

      this.#setActiveTab(this.#activeBlockId, { animate });
    } else {
      // Accordion rows always start fully collapsed on entering mobile - simpler and more
      // predictable than trying to carry open/active state across a breakpoint switch, and not
      // something shoppers rely on mid-interaction.
      triggers.forEach((trigger) => {
        const row = trigger.closest('.product-info-tab');
        const heading = row?.querySelector('.product-info-tab__heading');
        heading?.append(trigger);
        trigger.removeAttribute('role');
        trigger.removeAttribute('tabindex');
        trigger.removeAttribute('aria-selected');
        trigger.setAttribute('aria-expanded', 'false');
      });
      if (tablist) tablist.hidden = true;

      panels.forEach((panel) => {
        panel.removeAttribute('role');
        panel.hidden = true;
        panel.style.removeProperty('height');
        panel.style.removeProperty('overflow');
      });
    }

    if (focused && this.contains(focused) && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
  }

  /** @param {HTMLElement} trigger */
  #blockIdFor(trigger) {
    return trigger.closest('.product-info-tab')?.id.replace('ProductInfoTab-', '') ?? '';
  }

  /** @param {HTMLElement} panel */
  #triggerFor(panel) {
    const id = panel.getAttribute('aria-labelledby');
    return id ? document.getElementById(id) : null;
  }

  /**
   * Handles a click on any tab-item trigger, in either presentation.
   * @param {PointerEvent} event
   */
  handleTriggerClick = (event) => {
    const trigger = /** @type {HTMLElement | null} */ (
      (/** @type {HTMLElement} */ (event.target)).closest('.product-info-tab__trigger')
    );
    if (!trigger) return;

    if (isDesktopBreakpoint()) {
      this.#setActiveTab(this.#blockIdFor(trigger), { animate: true });
    } else {
      this.#toggleAccordionRow(trigger);
    }
  };

  /**
   * Arrow-key/Home/End navigation between tabs (desktop only - the tablist is empty and hidden
   * on mobile, so this listener is effectively inert there).
   * @param {KeyboardEvent} event
   */
  handleTablistKeydown = (event) => {
    const { triggers } = this.refs;
    if (!triggers?.length) return;

    const currentIndex = triggers.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (currentIndex === -1) return;

    let nextIndex;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % triggers.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + triggers.length) % triggers.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = triggers.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextTrigger = triggers[nextIndex];
    nextTrigger.focus();
    this.#setActiveTab(this.#blockIdFor(nextTrigger), { animate: true });
  };

  /**
   * @param {string} blockId
   * @param {{ animate: boolean }} options
   */
  #setActiveTab(blockId, { animate }) {
    const { triggers, panels } = this.refs;
    if (!triggers?.length || !panels?.length) return;

    const previousPanel = panels.find((panel) => !panel.hidden) ?? null;
    const nextPanel = panels.find((panel) => this.#blockIdFor(this.#triggerFor(panel) ?? panel) === blockId);
    if (!nextPanel || nextPanel === previousPanel) {
      this.#activeBlockId = blockId;
      return;
    }

    triggers.forEach((trigger) => {
      const isActive = this.#blockIdFor(trigger) === blockId;
      trigger.setAttribute('aria-selected', String(isActive));
      trigger.setAttribute('tabindex', isActive ? '0' : '-1');
    });

    const startHeight = previousPanel?.offsetHeight ?? 0;

    if (previousPanel) previousPanel.hidden = true;
    nextPanel.hidden = false;
    const endHeight = nextPanel.scrollHeight;

    if (animate && !prefersReducedMotion() && previousPanel) {
      this.#animateHeight(nextPanel, startHeight, endHeight);
    }

    this.#activeBlockId = blockId;
    this.dispatchEvent(new ProductInfoTabSelectEvent({ blockId, presentation: 'tab' }));
  }

  /** @param {HTMLElement} trigger */
  #toggleAccordionRow(trigger) {
    const panelId = trigger.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!panel) return;

    const expanded = trigger.getAttribute('aria-expanded') === 'true';

    if (expanded) {
      const startHeight = panel.offsetHeight;
      trigger.setAttribute('aria-expanded', 'false');
      if (prefersReducedMotion()) {
        panel.hidden = true;
      } else {
        this.#animateHeight(panel, startHeight, 0, () => {
          panel.hidden = true;
        });
      }
    } else {
      panel.hidden = false;
      const endHeight = panel.scrollHeight;
      trigger.setAttribute('aria-expanded', 'true');
      if (!prefersReducedMotion()) {
        this.#animateHeight(panel, 0, endHeight);
      }
    }

    this.dispatchEvent(
      new ProductInfoTabSelectEvent({ blockId: this.#blockIdFor(trigger), presentation: 'accordion' })
    );
  }

  /**
   * @param {HTMLElement} panel
   * @param {number} startHeight
   * @param {number} endHeight
   * @param {() => void} [onFinish]
   */
  #animateHeight(panel, startHeight, endHeight, onFinish) {
    this.#animation?.cancel();
    panel.style.overflow = 'hidden';

    this.#animation = panel.animate(
      { height: [`${startHeight}px`, `${endHeight}px`] },
      { duration: this.#speed, easing: 'ease-in-out' }
    );

    this.#animation.onfinish = () => {
      panel.style.removeProperty('height');
      panel.style.removeProperty('overflow');
      onFinish?.();
    };
  }

  get #speed() {
    const value = parseFloat(getComputedStyle(this).getPropertyValue('--product-info-animation-speed'));
    return Number.isFinite(value) ? value : 200;
  }
}

if (!customElements.get('product-info-tabs')) {
  customElements.define('product-info-tabs', ProductInfoTabs);
}
