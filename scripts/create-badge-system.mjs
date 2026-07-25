#!/usr/bin/env node
/**
 * Creates the badge_system metaobject definition + product metafield definition for the
 * tag/rule-driven product badge system. Run this ONCE per store before running
 * scripts/seed-default-badges.mjs.
 *
 * Requires (read from the environment - never hardcode a token in this file):
 *   SHOPIFY_STORE_DOMAIN         e.g. "your-store.myshopify.com"
 *   SHOPIFY_ADMIN_ACCESS_TOKEN   an Admin API access token with write_metaobject_definitions
 *                                and write_products (metafield definitions) scopes
 *   SHOPIFY_ADMIN_API_VERSION    optional, defaults to 2026-04
 *
 * Usage:
 *   SHOPIFY_STORE_DOMAIN=your-store.myshopify.com \
 *   SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxx \
 *   node scripts/create-badge-system.mjs
 *
 * Idempotency: re-running this after a successful run will fail with a user error saying the
 * type/namespace+key already exists - that's expected and safe to ignore.
 */

const domain = process.env.SHOPIFY_STORE_DOMAIN;
const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || '2026-04';

if (!domain || !token) {
  console.error('Missing SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_ACCESS_TOKEN in the environment.');
  console.error('This script never reads a token from a committed file - pass it as an env var each run.');
  process.exit(1);
}

async function adminGraphQL(query, variables) {
  const response = await fetch(`https://${domain}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await response.json();
  if (!response.ok || body.errors) {
    throw new Error(`GraphQL request failed: ${response.status} ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

// Choices validations are expressed as a JSON-encoded array string (confirmed via the Admin
// API's metafieldDefinitionTypes query: single_line_text_field's "choices" validation has type
// list.single_line_text_field, i.e. a JSON array of strings).
const choices = (values) => JSON.stringify(values);

const METAOBJECT_TYPE = 'badge_system_badge';

const CREATE_METAOBJECT_DEFINITION = `#graphql
  mutation CreateBadgeMetaobjectDefinition($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition {
        id
        type
        fieldDefinitions {
          key
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const metaobjectDefinitionInput = {
  type: METAOBJECT_TYPE,
  name: 'Badge',
  // Definition-level capability - Shopify's per-field "translatable" toggle doesn't exist;
  // translation eligibility is a definition-wide capability, and eligible field types (text
  // fields, including `label` here) become translatable through Shopify's standard resource
  // translation UI/API once this is enabled.
  capabilities: {
    translatable: { enabled: true },
    publishable: { enabled: true },
  },
  fieldDefinitions: [
    {
      key: 'label',
      name: 'Label',
      type: 'single_line_text_field',
      required: true,
      description: 'The text shown on the badge. Translatable per-entry via Shopify’s standard resource translation.',
    },
    {
      key: 'mode',
      name: 'Mode',
      type: 'single_line_text_field',
      required: true,
      description: '"manual" badges are assigned per-product via the product’s Badges metafield. "automatic" badges are evaluated by the Rule field below and apply to every matching product with no per-product assignment needed.',
      validations: [{ name: 'choices', value: choices(['manual', 'automatic']) }],
    },
    {
      key: 'rule',
      name: 'Rule',
      type: 'single_line_text_field',
      required: false,
      description: 'Only used when Mode is "automatic". "new" compares the product’s creation date against the theme’s "New badge: days" setting. "preorder" matches a variant that’s sellable while out of stock (continue-selling-when-out-of-stock).',
      validations: [{ name: 'choices', value: choices(['on_sale', 'sold_out', 'new', 'preorder']) }],
    },
    {
      key: 'enabled',
      name: 'Enabled',
      type: 'boolean',
      required: true,
      description: 'Disabled badges are never shown, even if manually assigned to a product or matching an automatic rule.',
    },
    {
      key: 'style',
      name: 'Style',
      type: 'single_line_text_field',
      required: true,
      description: 'Visual style, built from the theme’s existing color palette (no per-badge color picker) so every badge stays visually consistent with the rest of the storefront.',
      validations: [{ name: 'choices', value: choices(['primary', 'secondary', 'outline', 'inverse']) }],
    },
    {
      key: 'icon',
      name: 'Icon',
      type: 'file_reference',
      required: false,
      description: 'Optional. Shown next to the label - the label text always renders too, so the badge is never icon-only.',
    },
    {
      key: 'position',
      name: 'Position',
      type: 'single_line_text_field',
      required: true,
      description: '"none" excludes this badge from the product image/card overlay entirely - it still renders through the product-page content badge block.',
      validations: [{ name: 'choices', value: choices(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'none']) }],
    },
    {
      key: 'placement_context',
      name: 'Placement context',
      type: 'list.single_line_text_field',
      required: true,
      description: 'Where this badge is allowed to render. Enter one or both, spelled exactly: "image" (product image/card overlay) and/or "content" (the product page badge block). Overlay contexts cap at 3 badges per position; the content block’s cap is a separate, merchant-configurable block setting.',
      // No "choices" validation applied here - list.single_line_text_field's own choices-style
      // constraint could not be confirmed against the live API schema during development, so
      // this relies on the description above plus defensive handling in the Liquid resolver
      // (an unrecognized value simply never matches placement_context filters, rather than
      // erroring).
    },
  ],
};

const CREATE_METAFIELD_DEFINITION = `#graphql
  mutation CreateBadgeMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        namespace
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

async function main() {
  console.log(`Creating "${METAOBJECT_TYPE}" metaobject definition on ${domain} (API ${apiVersion})...`);
  const metaobjectResult = await adminGraphQL(CREATE_METAOBJECT_DEFINITION, { definition: metaobjectDefinitionInput });
  const { metaobjectDefinition, userErrors: metaobjectErrors } = metaobjectResult.metaobjectDefinitionCreate;

  if (metaobjectErrors.length > 0) {
    console.error('metaobjectDefinitionCreate returned errors:');
    console.error(JSON.stringify(metaobjectErrors, null, 2));
    process.exit(1);
  }

  console.log(`Created metaobject definition: ${metaobjectDefinition.id}`);

  console.log('Creating "badge_system.badges" product metafield definition...');
  const metafieldDefinitionInput = {
    name: 'Badges',
    namespace: 'badge_system',
    key: 'badges',
    type: 'list.metaobject_reference',
    ownerType: 'PRODUCT',
    description: 'Manually-assigned badges for this product, in display priority order. Automatic badges (Sale, Sold Out, etc.) are evaluated separately and always take precedence - see the Badge metaobject entries.',
    validations: [{ name: 'metaobject_definition_id', value: metaobjectDefinition.id }],
  };
  const metafieldResult = await adminGraphQL(CREATE_METAFIELD_DEFINITION, { definition: metafieldDefinitionInput });
  const { createdDefinition, userErrors: metafieldErrors } = metafieldResult.metafieldDefinitionCreate;

  if (metafieldErrors.length > 0) {
    console.error('metafieldDefinitionCreate returned errors:');
    console.error(JSON.stringify(metafieldErrors, null, 2));
    process.exit(1);
  }

  console.log(`Created metafield definition: ${createdDefinition.namespace}.${createdDefinition.key} (${createdDefinition.id})`);
  console.log('\nDone. Next: run scripts/seed-default-badges.mjs to create the 4 default automatic badges.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
