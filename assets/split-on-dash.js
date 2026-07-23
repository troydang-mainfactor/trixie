/**
 * Opt-in Text block behavior: if the block's rendered text contains " - ", wraps everything
 * after the first occurrence in a `.text-block__subtitle` span (styled smaller, on its own
 * line via CSS). Operates on the live DOM via TreeWalker rather than the raw HTML string,
 * since a rich text field's content is arbitrary markup, not guaranteed to be a single tag.
 *
 * @param {HTMLElement} el
 */
function splitOnDash(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  /** @type {Text | null} */
  let node;

  while ((node = /** @type {Text | null} */ (walker.nextNode()))) {
    const index = node.textContent?.indexOf(' - ') ?? -1;
    if (index === -1) continue;

    const before = node.textContent.slice(0, index);
    const after = node.textContent.slice(index + ' - '.length);

    const subtitle = document.createElement('span');
    subtitle.className = 'text-block__subtitle';
    subtitle.textContent = after;

    node.textContent = before;
    node.parentNode?.insertBefore(subtitle, node.nextSibling);
    break;
  }
}

document.querySelectorAll('[data-split-on-dash="true"]:not([data-split-on-dash-applied])').forEach((el) => {
  if (!(el instanceof HTMLElement)) return;

  el.setAttribute('data-split-on-dash-applied', 'true');
  splitOnDash(el);
});
