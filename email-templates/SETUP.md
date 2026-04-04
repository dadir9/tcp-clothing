# TCP Clothing — Email Template Setup Guide

## Templates Overview

| File | Type | Trigger |
|------|------|---------|
| `order-confirmation.html` | Notification (transactional) | Every order placed |
| `abandoned-cart-1.html` | Automation | ~1hr after cart abandonment |
| `abandoned-cart-2.html` | Automation | ~24hr after cart abandonment |
| `abandoned-cart-3.html` | Automation | ~72hr after cart abandonment |
| `welcome.html` | Automation | After newsletter signup |
| `newsletter.html` | Campaign | Weekly editorial send |
| `launch-announcement.html` | Campaign | One-time, product launches |

## Step 1 — Update Logo URL

Before uploading any template, replace the placeholder logo URL with your actual CDN URL:

1. Go to Shopify Admin → Content → Files
2. Upload `assets/logo-white.png` (white version of the logo)
3. Copy the CDN URL (looks like `https://cdn.shopify.com/s/files/1/XXXX/XXXX/files/logo-white.png`)
4. Find and replace in all templates:
   ```
   https://cdn.shopify.com/s/files/1/tcp-clothing/logo-white.png
   ```
   → replace with your actual CDN URL

## Step 2 — Order Confirmation Notification

1. Shopify Admin → Settings → Notifications
2. Click **Order confirmation**
3. Click **Edit code**
4. Paste the full contents of `order-confirmation.html`
5. Click **Save** → **Preview** to verify

## Step 3 — Abandoned Cart Automation (Shopify Email)

Requires the **Shopify Email** app (free, install from App Store).

1. Shopify Admin → Marketing → Automations → **Create automation**
2. Select **Abandoned checkout**
3. Add 3 email steps:
   - Step 1: Delay 1 hour → paste `abandoned-cart-1.html` content
   - Step 2: Delay 24 hours → paste `abandoned-cart-2.html` content
   - Step 3: Delay 72 hours → paste `abandoned-cart-3.html` content
4. Set condition: only send if checkout is still abandoned
5. **Activate** the automation

## Step 4 — Welcome Series Automation

1. Shopify Admin → Marketing → Automations → **Create automation**
2. Select **Welcome new subscriber**
3. Add 1 email step (can expand to series later):
   - Delay: Immediately → paste `welcome.html` content
4. **Activate** the automation

## Step 5 — Newsletter Campaigns

`newsletter.html` is a template for the weekly **The Weekly Edit** campaign.

1. Shopify Admin → Marketing → Campaigns → **Create campaign** → **Email**
2. Paste `newsletter.html` as the email body
3. Update product links, images, and dates for each send
4. Schedule for Tuesday or Thursday 10:00 CET (best open rates)

## Step 6 — Verify Marketing Consent

The newsletter signup form on the homepage already sets `contact[accepts_marketing]=true`.
Subscribers will appear in **Customers** with "Email subscribed" status.

To confirm: Shopify Admin → Customers → filter by "Email subscribed"

## Notes

- All templates use `{{ shop.url }}` for store links — no hardcoded URLs
- All templates are mobile-responsive (tested to 320px)
- For FR/NL translations: duplicate each template and add `{% if customer.locale == 'fr' %}` conditional blocks, or use Shopify Translate & Adapt
- The `{{ unsubscribe_url }}` variable is automatically injected by Shopify Email — do not remove it
