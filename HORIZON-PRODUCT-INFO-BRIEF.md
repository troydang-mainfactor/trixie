# Premium Product Information — Build Brief

## 0. Summary

Build a "Premium Product Information" component: a horizontal tab interface on desktop that
collapses to accordions on mobile, used on the product page to show Description, Ingredients,
How To Use, Shipping, FAQ, etc.

Hard constraint: this component will be reused across many different stores and product types
(cosmetics, apparel, electronics, home goods, and others not yet known). Nothing about a specific
brand, vertical, tab name, content value, or number of tabs may be hardcoded into the Liquid, JSON
schema, JS, or CSS. Every piece of merchant-facing content and every default must come from a
schema setting, a translation key, or the product/store data itself — never a literal English
string like "Ingredients" baked into logic, never a fixed count of tabs, never a vertical-specific
assumption anywhere outside of illustrative examples in comments.

## 1. Architecture decision

One `tab-item` theme block (not a closed list of typed blocks). Each instance of that block is one
tab. The merchant adds as many as they want, in any order, and each instance independently
configures: its own title, icon, small heading, content source, and visibility rules.

The parent section (`product-information.liquid`) owns only: layout mode (underline/pills/minimal/
cards), content width, radius, border, background, padding, animation speed, icon toggle, and
typography — i.e. presentation, not content.

## 1a. Genericity requirements (checklist during implementation and review)

- No hardcoded tab names, anywhere (Liquid, JS, CSS). Never `{% if block.settings.tab_title ==
  "Ingredients" %}`.
- No hardcoded content — no default rich-text copy, no placeholder paragraph text, no sample
  ingredient list. Section ships with zero content of its own.
- No fixed tab count — loop over `section.blocks` directly, however many there are.
- No vertical-specific logic — visibility rule *types* are generic categories; the *values*
  merchants type in are free text/pickers, not a fixed dropdown of pre-written verticals.
- No assumed icon set or asset library — icon field is plain text/reference, not wired to a
  specific icon pack.
- All merchant-facing labels use translation keys (`t:`), not inline English strings, in every
  schema file.
- No default/starter blocks with pre-filled titles — preset ships with zero blocks.

## 2. Content resolution & visibility — the two-pass rule

Every tab must pass two independent checks, evaluated server-side in Liquid, before it's counted
as "present":

1. Visibility rules (product type / vendor / template / tags / collection / availability /
   metafield value / customer login / always-show; ALL or ANY match).
2. Content presence — the selected source, once resolved, is non-empty after stripping
   whitespace/empty HTML tags.

A tab only renders if both pass, computed before any markup is emitted. Zero qualifying tabs → the
section itself renders nothing (early `{% if %}` around the whole section, not `display:none` on
an empty shell).

## 3. File map

```
sections/product-information.liquid          # wrapper: layout, tablist markup, settings
blocks/tab-item.liquid                        # one theme block = one tab
snippets/product-info-resolve-content.liquid  # content-source resolution (pure function style)
snippets/product-info-check-visibility.liquid # visibility rule evaluation (pure function style)
assets/product-info.js                        # custom element: tablist/accordion behavior
assets/product-info.css                       # component styles, uses Horizon CSS variables
locales/en.default.schema.json                # new schema strings (append, don't replace)
```

## 4. Section schema (`product-information.liquid`)

Settings: `layout_style` (select: underline/pills/minimal/cards), `content_width` (range 480-900px),
`container_radius` (range 0-24px), `show_border` (checkbox), `background` (color_background),
`content_padding` (range 0-64px), `animation_speed` (range 120-320ms), `enable_icons` (checkbox),
typography header + `tab_font`. Blocks: `[{"type": "@theme"}, {"type": "@app"}]`. Preset ships with
zero blocks.

## 5. Block schema (`blocks/tab-item.liquid`)

Settings: `tab_title` (text), `small_heading` (text, optional), `show_icon` (checkbox), `icon`
(text, visible_if show_icon — free-text reference, not a fixed icon library), `content_source`
(select: rich_text/metafield/product_description/page/metaobject/dynamic_source/custom_liquid)
with one source-specific field per option shown via `visible_if`, then a "Visibility rules" header
with `visibility_match` (all/any) and 2-3 rule slots (`rule_N_type` + `rule_N_value`), each rule
type being one of: none/product_type/product_vendor/product_template/product_tag/collection/
availability/metafield_value/customer_logged_in.

Keep rule slots to a fixed small number in the schema (Liquid schema can't do dynamic repeating
groups) but write the visibility snippet so it loops over however many rule slots exist, so adding
a rule_4 later is a schema-only change, not a logic rewrite.

## 6. JS architecture (`assets/product-info.js`)

- Custom element (`<product-info-tabs>`), matching Horizon's own convention of behavior-bearing
  custom elements.
- Desktop: `role="tablist"`/`role="tab"`/`role="tabpanel"`, roving tabindex.
- Height animation: measure target panel's `scrollHeight`, animate the container's `height` via
  the Web Animations API (`element.animate(...)`) over `animation_speed` ms. Respect
  `prefers-reduced-motion`.
- Mobile breakpoint: same underlying data, accordion semantics (`<button aria-expanded>` +
  `role="region"`), driven by a single CSS breakpoint check, not a duplicated component.
- Use Horizon's `ThemeEvents` (from `events.js` in this theme) to dispatch a custom event on tab
  change if other sections might need to react.
- No library, no polling, event delegation for tab clicks (one listener on the tablist container).

## 7. CSS (`assets/product-info.css`)

- Use Horizon's existing CSS custom properties for color, spacing, radius.
- Four layout variants as data-attribute/class modifiers on one shared structure.
- No box-shadow beyond Horizon's own subtle elevation tokens.
- Border: 1px, low-contrast token color, only when `show_border` is on.

## 8. Accessibility checklist

- Tablist: `role="tablist"`, each tab `role="tab"`, `aria-selected`, `aria-controls`, roving
  `tabindex`.
- Panel: `role="tabpanel"`, `aria-labelledby`.
- Arrow-key navigation (Left/Right, Home/End).
- Accordion (mobile): real `<button>`, `aria-expanded`, `aria-controls`; content `role="region"` +
  `aria-labelledby`.
- Focus never lost when switching breakpoints mid-interaction.
- `prefers-reduced-motion` disables the height/underline animation, not just slows it.

## 9. Non-goals

- No settings migration for existing stores with a different product info section already in
  place.
- No JS animation library, icon library, or CSS framework.
- No more than 2-3 visibility rule slots per tab in this iteration.
- No pre-filled tab names, sample copy, or vertical-specific default content.
