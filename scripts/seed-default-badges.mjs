#!/usr/bin/env node
/**
 * Seeds the 4 default automatic badges (Sale, Sold Out, New, Preorder) as badge_system_badge
 * metaobject entries. Run scripts/create-badge-system.mjs first - this script fails if the
 * "badge_system_badge" metaobject definition doesn't exist yet.
 *
 * Requires (read from the environment - never hardcode a token in this file):
 *   SHOPIFY_STORE_DOMAIN         e.g. "your-store.myshopify.com"
 *   SHOPIFY_ADMIN_ACCESS_TOKEN   an Admin API access token with write_metaobjects scope
 *   SHOPIFY_ADMIN_API_VERSION    optional, defaults to 2026-04
 *
 * Usage:
 *   SHOPIFY_STORE_DOMAIN=your-store.myshopify.com \
 *   SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxx \
 *   node scripts/seed-default-badges.mjs
 *
 * Idempotency: re-running creates duplicate entries (metaobjectCreate doesn't dedupe by field
 * values) - check the admin's Content > Metaobjects > Badge list before re-running.
 */

const domain = process.env.SHOPIFY_STORE_DOMAIN;
const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || '2026-04';

if (!domain || !token) {
  console.error('Missing SHOPIFY_STORE_DOMAIN and/or SHOPIFY_ADMIN_ACCESS_TOKEN in the environment.');
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

const METAOBJECT_TYPE = 'badge_system_badge';

const CREATE_METAOBJECT = `#graphql
  mutation CreateBadge($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject {
        id
        handle
        field(key: "label") {
          value
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

const field = (key, value) => ({ key, value });

const DEFAULT_BADGES = [
  {
    label: 'Sale',
    rule: 'on_sale',
    style: 'primary',
    position: 'top-left',
  },
  {
    label: 'Sold Out',
    rule: 'sold_out',
    style: 'secondary',
    position: 'top-left',
  },
  {
    label: 'New',
    rule: 'new',
    style: 'outline',
    position: 'top-right',
  },
  {
    label: 'Preorder',
    rule: 'preorder',
    style: 'inverse',
    position: 'top-right',
  },
];

async function createBadge({ label, rule, style, position }) {
  const metaobject = {
    type: METAOBJECT_TYPE,
    capabilities: { publishable: { status: 'ACTIVE' } },
    fields: [
      field('label', label),
      field('mode', 'automatic'),
      field('rule', rule),
      field('enabled', 'true'),
      field('style', style),
      field('position', position),
      field('placement_context', JSON.stringify(['image', 'content'])),
    ],
  };

  const result = await adminGraphQL(CREATE_METAOBJECT, { metaobject });
  const { metaobject: created, userErrors } = result.metaobjectCreate;

  if (userErrors.length > 0) {
    console.error(`Failed to create "${label}":`, JSON.stringify(userErrors, null, 2));
    return false;
  }

  console.log(`Created "${label}" (${created.id})`);
  return true;
}

async function main() {
  console.log(`Seeding default badges on ${domain} (API ${apiVersion})...`);
  let successCount = 0;
  for (const badge of DEFAULT_BADGES) {
    const ok = await createBadge(badge);
    if (ok) successCount += 1;
  }
  console.log(`\nDone. ${successCount}/${DEFAULT_BADGES.length} default badges created.`);
  if (successCount < DEFAULT_BADGES.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
