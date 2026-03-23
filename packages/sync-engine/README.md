# Stripe Sync Engine

![GitHub License](https://img.shields.io/github/license/stripe-experiments/sync-engine)
![NPM Version](https://img.shields.io/npm/v/@stripe%2Fsync-engine)

Sync Stripe data into PostgreSQL from the command line.

## Install

```sh
npm install @stripe/sync-engine stripe
# or
pnpm add @stripe/sync-engine stripe
# or
yarn add @stripe/sync-engine stripe
```

## Run Sync (CLI)

Set environment variables:

```sh
export STRIPE_API_KEY=sk_live_xxx
export DATABASE_URL=postgres://...
```

Then run either command:

```sh
# 1) Sync everything
npx @stripe/sync-engine sync \
  --stripe-key $STRIPE_API_KEY \
  --database-url $DATABASE_URL

# 2) Sync one object type
npx @stripe/sync-engine sync customer \
  --stripe-key $STRIPE_API_KEY \
  --database-url $DATABASE_URL
```

> **Note:** `sync` automatically applies any pending database migrations before syncing data.

## Supported Objects

When you run `sync all`, the engine discovers all listable resources from the Stripe OpenAPI spec and syncs them automatically. The following resources are synced (availability depends on your Stripe account's enabled products):

| Category                  | Resources                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core**                  | `accounts`, `charges`, `customers`, `events`, `payouts`, `refunds`, `disputes`, `balance_transactions`                                                                                                                                                                                                                                    |
| **Billing**               | `invoices`, `subscriptions`, `subscription_schedules`, `credit_notes`, `plans`, `prices`, `products`, `coupons`, `promotion_codes`, `tax_ids`, `tax_rates`, `tax_codes`, `tax_registrations`, `quotes`, `billing_alerts`, `billing_credit_balance_transactions`, `billing_credit_grants`, `billing_meters`, `invoice_rendering_templates` |
| **Payments**              | `payment_intents`, `payment_methods`, `payment_links`, `payment_method_configurations`, `payment_method_domains`, `setup_intents`, `checkout_sessions`                                                                                                                                                                                    |
| **Connect**               | `application_fees`, `country_specs`, `topups`, `transfers`                                                                                                                                                                                                                                                                                |
| **Reporting**             | `reporting_report_runs`, `reporting_report_types`, `scheduled_query_runs`                                                                                                                                                                                                                                                                 |
| **Radar**                 | `radar_value_lists`, `reviews`, `early_fraud_warnings`                                                                                                                                                                                                                                                                                    |
| **Identity**              | `identity_verification_reports`, `identity_verification_sessions`                                                                                                                                                                                                                                                                         |
| **Issuing**               | `issuing_personalization_designs`, `issuing_physical_bundles`                                                                                                                                                                                                                                                                             |
| **Terminal**              | `terminal_configurations`, `terminal_locations`, `terminal_readers`                                                                                                                                                                                                                                                                       |
| **Financial Connections** | `financial_connections_accounts`                                                                                                                                                                                                                                                                                                          |
| **Climate**               | `climate_orders`, `climate_products`, `climate_suppliers`                                                                                                                                                                                                                                                                                 |
| **Forwarding**            | `forwarding_requests`                                                                                                                                                                                                                                                                                                                     |
| **Shipping**              | `shipping_rates`                                                                                                                                                                                                                                                                                                                          |
| **Files**                 | `files`, `file_links`                                                                                                                                                                                                                                                                                                                     |
| **Entitlements**          | `features`                                                                                                                                                                                                                                                                                                                                |
| **Billing Portal**        | `billing_portal_configurations`                                                                                                                                                                                                                                                                                                           |
| **Webhook**               | `webhook_endpoints`                                                                                                                                                                                                                                                                                                                       |
| **Other**                 | `exchange_rates`, `test_helpers_test_clocks`                                                                                                                                                                                                                                                                                              |
| **V2 API**                | `v2_core_accounts`, `v2_core_event_destinations`, `v2_core_events`                                                                                                                                                                                                                                                                        |

Resources requiring special account access (Treasury, Issuing cards/cardholders, Sigma) are automatically skipped if your account hasn't enabled those products.

You can also sync a single object type:

```sh
npx @stripe/sync-engine sync customer
```

## License

See [LICENSE](LICENSE) file.

## Contributing

Issues and pull requests are welcome at [https://github.com/stripe-experiments/sync-engine](https://github.com/stripe-experiments/sync-engine).
