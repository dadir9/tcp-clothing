#!/usr/bin/env node
/**
 * TCP Clothing — Shopify Admin API Setup Script
 *
 * Runs three setup operations in sequence:
 *   1. Bulk-import products from product-import.csv
 *   2. Create smart collections (one per product category)
 *   3. Register metafield definitions (fabric, care, sustainability)
 *
 * Prerequisites:
 *   node >= 18  (uses native fetch)
 *   npm install csv-parse
 *
 * Usage:
 *   SHOPIFY_ACCESS_TOKEN=shpat_xxxx node scripts/shopify-setup.js
 *
 * The access token must be a Private App / Custom App token with scopes:
 *   write_products, write_product_listings, write_inventory,
 *   write_metafield_definitions, write_metafields
 *
 * HOW TO GET THE TOKEN:
 *   Shopify Admin → Settings → Apps and sales channels → Develop apps
 *   → Create an app → Configure Admin API scopes (above) → Install app
 *   → Copy the "Admin API access token" (starts with shpat_)
 */

const fs   = require('fs');
const path = require('path');

const STORE    = 'msa-9587.myshopify.com';
const API_VER  = '2024-04';
const BASE_URL = `https://${STORE}/admin/api/${API_VER}`;
const TOKEN    = process.env.SHOPIFY_ACCESS_TOKEN;

if (!TOKEN) {
  console.error('ERROR: set SHOPIFY_ACCESS_TOKEN=shpat_xxx before running.');
  process.exit(1);
}

const headers = {
  'Content-Type':              'application/json',
  'X-Shopify-Access-Token':    TOKEN,
};

// ─── helpers ───────────────────────────────────────────────────────────────

async function shopify(method, endpoint, body) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Respect Shopify rate-limit header
  const callLimit = res.headers.get('X-Shopify-Shop-Api-Call-Limit');
  if (callLimit) {
    const [used, max] = callLimit.split('/').map(Number);
    if (used >= max - 2) {
      console.log('  Rate limit approaching, sleeping 1s…');
      await sleep(1000);
    }
  }

  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${endpoint} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ─── 1. Parse CSV ───────────────────────────────────────────────────────────

function parseProductCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  const headers = parseCSVLine(lines[0]);

  const rows = lines.slice(1).map(l => {
    const values = parseCSVLine(l);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });

  // Group rows by Handle (first row = product, subsequent = variants)
  const products = {};
  const order    = [];

  for (const row of rows) {
    const handle = row['Handle'];
    if (!handle) continue;

    if (!products[handle]) {
      products[handle] = { ...row, _variants: [] };
      order.push(handle);
    }

    const variant = {
      sku:                row['Variant SKU'],
      price:              row['Variant Price'],
      compare_at_price:   row['Variant Compare At Price'] || null,
      grams:              parseInt(row['Variant Grams'] || '0'),
      requires_shipping:  row['Variant Requires Shipping'] === 'TRUE',
      taxable:            row['Variant Taxable'] === 'TRUE',
      inventory_quantity: parseInt(row['Variant Inventory Qty'] || '10'),
      inventory_management: row['Variant Inventory Tracker'] || 'shopify',
      inventory_policy:   row['Variant Inventory Policy'] || 'deny',
      fulfillment_service: 'manual',
      weight_unit:        row['Variant Weight Unit'] || 'kg',
    };

    // Attach option values
    if (row['Option1 Value']) variant.option1 = row['Option1 Value'];
    if (row['Option2 Value']) variant.option2 = row['Option2 Value'];
    if (row['Option3 Value']) variant.option3 = row['Option3 Value'];

    products[handle]._variants.push(variant);
  }

  return order.map(h => products[h]);
}

function parseCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ─── 2. Build product payload ───────────────────────────────────────────────

function buildProductPayload(row) {
  // Collect distinct option names
  const optionNames = [];
  if (row['Option1 Name']) optionNames.push(row['Option1 Name']);
  if (row['Option2 Name']) optionNames.push(row['Option2 Name']);
  if (row['Option3 Name']) optionNames.push(row['Option3 Name']);

  return {
    product: {
      title:        row['Title'],
      body_html:    row['Body (HTML)'],
      vendor:       row['Vendor'],
      product_type: row['Type'],
      tags:         row['Tags'],
      status:       (row['Status'] || 'draft').toLowerCase(),
      published:    row['Published'] === 'TRUE',
      options:      optionNames.map(name => ({ name })),
      variants:     row._variants,
      metafields: [
        {
          namespace: 'seo',
          key:       'title',
          value:     row['SEO Title'] || row['Title'],
          type:      'single_line_text_field',
        },
        {
          namespace: 'seo',
          key:       'description',
          value:     row['SEO Description'] || '',
          type:      'multi_line_text_field',
        },
      ].filter(m => m.value),
    },
  };
}

// ─── 3. Create products ─────────────────────────────────────────────────────

async function importProducts(csvPath) {
  log('=== Step 1: Importing products ===');
  const products = parseProductCSV(csvPath);
  log(`Found ${products.length} products to import`);

  const results = [];

  for (const row of products) {
    try {
      log(`  Creating: ${row['Title']}`);
      const payload  = buildProductPayload(row);
      const response = await shopify('POST', '/products.json', payload);
      log(`  ✓ Created product ID ${response.product.id} — ${response.product.title}`);
      results.push({ handle: row['Handle'], id: response.product.id, status: 'ok' });
      await sleep(500); // stay well within rate limits
    } catch (err) {
      log(`  ✗ Failed: ${row['Handle']} — ${err.message}`);
      results.push({ handle: row['Handle'], id: null, status: 'error', error: err.message });
    }
  }

  log(`Products done: ${results.filter(r => r.status === 'ok').length} created, ${results.filter(r => r.status === 'error').length} failed`);
  return results;
}

// ─── 4. Smart Collections ──────────────────────────────────────────────────

const COLLECTIONS = [
  {
    title:       'Swimwear',
    handle:      'swimwear',
    body_html:   '<p>Our curated swimwear collection — from classic bikinis to bold one-pieces. Designed for British beaches, the Côte d\'Azur, and Dutch coastlines.</p>',
    rules:       [{ column: 'type', relation: 'equals', condition: 'Swimwear' }],
    sort_order:  'best-selling',
    published:   true,
    image_alt:   'TCP Clothing Swimwear Collection',
  },
  {
    title:       'Linen Collection',
    handle:      'linen-collection',
    body_html:   '<p>Effortlessly chic European linen pieces. Breathable, sustainable, and built for long summer days.</p>',
    rules:       [{ column: 'type', relation: 'equals', condition: 'Linen Collection' }],
    sort_order:  'best-selling',
    published:   true,
    image_alt:   'TCP Clothing Linen Collection',
  },
  {
    title:       'Festival Wear',
    handle:      'festival-wear',
    body_html:   '<p>Standout pieces made for festival fields, beach bars, and golden-hour adventures.</p>',
    rules:       [{ column: 'type', relation: 'equals', condition: 'Festival Wear' }],
    sort_order:  'best-selling',
    published:   true,
    image_alt:   'TCP Clothing Festival Wear',
  },
  {
    title:       'Holiday Essentials',
    handle:      'holiday-essentials',
    body_html:   '<p>Everything you need for the perfect summer holiday — hats, bags, cover-ups, and more.</p>',
    rules:       [{ column: 'type', relation: 'equals', condition: 'Holiday Essentials' }],
    sort_order:  'best-selling',
    published:   true,
    image_alt:   'TCP Clothing Holiday Essentials',
  },
  {
    title:       'Accessories',
    handle:      'accessories',
    body_html:   '<p>Finishing touches for every look — handcrafted jewellery, woven belts, and more.</p>',
    rules:       [{ column: 'type', relation: 'equals', condition: 'Accessories' }],
    sort_order:  'best-selling',
    published:   true,
    image_alt:   'TCP Clothing Accessories',
  },
  {
    title:       'New In',
    handle:      'new-in',
    body_html:   '<p>The latest arrivals from TCP Clothing.</p>',
    rules:       [{ column: 'tag', relation: 'contains', condition: 'new-in' }],
    sort_order:  'created-desc',
    published:   true,
    image_alt:   'TCP Clothing New Arrivals',
  },
  {
    title:       'Sale',
    handle:      'sale',
    body_html:   '<p>Selected styles at reduced prices. While stocks last.</p>',
    rules:       [{ column: 'compare_at_price', relation: 'greater_than', condition: '0' }],
    sort_order:  'price-asc',
    published:   true,
    image_alt:   'TCP Clothing Sale',
  },
];

async function setupCollections() {
  log('=== Step 2: Creating smart collections ===');

  for (const col of COLLECTIONS) {
    try {
      log(`  Creating collection: ${col.title}`);
      const payload = {
        smart_collection: {
          title:      col.title,
          handle:     col.handle,
          body_html:  col.body_html,
          rules:      col.rules,
          disjunctive: false,
          sort_order: col.sort_order,
          published:  col.published,
        },
      };
      const res = await shopify('POST', '/smart_collections.json', payload);
      log(`  ✓ Created collection ID ${res.smart_collection.id} — ${res.smart_collection.title}`);
      await sleep(300);
    } catch (err) {
      log(`  ✗ Failed: ${col.title} — ${err.message}`);
    }
  }

  log('Collections done.');
}

// ─── 5. Metafield Definitions ───────────────────────────────────────────────
//
// Uses the GraphQL Admin API (metafield definitions are not available in REST)

async function setupMetafieldDefinitions() {
  log('=== Step 3: Registering metafield definitions ===');

  const graphqlUrl = `https://${STORE}/admin/api/${API_VER}/graphql.json`;

  const definitions = [
    {
      name:        'Fabric Composition',
      namespace:   'product_details',
      key:         'fabric_composition',
      description: 'Detailed breakdown of fabric/material composition (e.g. "80% recycled polyester, 20% elastane")',
      type:        'single_line_text_field',
      ownerType:   'PRODUCT',
    },
    {
      name:        'Care Instructions',
      namespace:   'product_details',
      key:         'care_instructions',
      description: 'Full washing and care instructions for the garment',
      type:        'multi_line_text_field',
      ownerType:   'PRODUCT',
    },
    {
      name:        'Sustainability Info',
      namespace:   'product_details',
      key:         'sustainability_info',
      description: 'Sustainability credentials (certifications, recycled content, ethical sourcing)',
      type:        'multi_line_text_field',
      ownerType:   'PRODUCT',
    },
    {
      name:        'Fit Guide',
      namespace:   'product_details',
      key:         'fit_guide',
      description: 'Model sizing info and fit notes (e.g. "Model is 5\'8" and wears a size S")',
      type:        'single_line_text_field',
      ownerType:   'PRODUCT',
    },
    {
      name:        'Country of Origin',
      namespace:   'product_details',
      key:         'country_of_origin',
      description: 'Country where the product was manufactured',
      type:        'single_line_text_field',
      ownerType:   'PRODUCT',
    },
  ];

  for (const def of definitions) {
    const mutation = `
      mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition {
            id
            name
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

    const variables = {
      definition: {
        name:        def.name,
        namespace:   def.namespace,
        key:         def.key,
        description: def.description,
        type:        def.type,
        ownerType:   def.ownerType,
        visibleToStorefrontApi: true,
      },
    };

    try {
      log(`  Creating metafield: ${def.namespace}.${def.key}`);
      const res = await fetch(graphqlUrl, {
        method:  'POST',
        headers,
        body:    JSON.stringify({ query: mutation, variables }),
      });
      const json = await res.json();
      const errors = json.data?.metafieldDefinitionCreate?.userErrors ?? [];

      if (errors.length) {
        // TAKEN means it already exists — not a real error
        const taken = errors.find(e => e.code === 'TAKEN');
        if (taken) {
          log(`  ~ Already exists: ${def.namespace}.${def.key}`);
        } else {
          log(`  ✗ Error: ${JSON.stringify(errors)}`);
        }
      } else {
        const created = json.data?.metafieldDefinitionCreate?.createdDefinition;
        log(`  ✓ Created: ${created?.id} — ${def.namespace}.${def.key}`);
      }

      await sleep(300);
    } catch (err) {
      log(`  ✗ Failed: ${def.namespace}.${def.key} — ${err.message}`);
    }
  }

  log('Metafield definitions done.');
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  const csvPath = path.join(__dirname, 'product-import.csv');

  if (!fs.existsSync(csvPath)) {
    console.error(`ERROR: CSV not found at ${csvPath}`);
    process.exit(1);
  }

  log('TCP Clothing — Shopify Setup Starting');
  log(`Store: ${STORE}`);
  log(`API version: ${API_VER}`);

  try {
    // Verify token works
    const shop = await shopify('GET', '/shop.json');
    log(`Connected to: ${shop.shop.name} (${shop.shop.myshopify_domain})`);
  } catch (err) {
    console.error('ERROR: Could not connect to Shopify. Check your access token.');
    console.error(err.message);
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const runAll = args.length === 0;

  if (runAll || args.includes('--products')) {
    await importProducts(csvPath);
  }

  if (runAll || args.includes('--collections')) {
    await setupCollections();
  }

  if (runAll || args.includes('--metafields')) {
    await setupMetafieldDefinitions();
  }

  log('Setup complete.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
