#!/usr/bin/env node

import { Command } from 'commander'
import pkg from '../../package.json' with { type: 'json' }
import {
  syncCommand,
  migrateCommand,
  backfillCommand,
  fullSyncCommand,
  monitorCommand,
  installCommand,
  uninstallCommand,
} from './commands'

const program = new Command()

program
  .name('stripe-experiment-sync')
  .description('CLI tool for syncing Stripe data to PostgreSQL')
  .version(pkg.version)

// Migrate command
program
  .command('migrate')
  .description('Run database migrations only')
  .option('--database-url <url>', 'Postgres DATABASE_URL (or DATABASE_URL env)')
  .option('--sigma', 'Create Sigma tables during migration')
  .action(async (options) => {
    await migrateCommand({
      databaseUrl: options.databaseUrl,
      enableSigma: options.sigma,
    })
  })

// Start command (main sync command)
program
  .command('start')
  .description('Start Stripe sync')
  .option('--stripe-key <key>', 'Stripe API key (or STRIPE_API_KEY env)')
  .option('--ngrok-token <token>', 'ngrok auth token (or NGROK_AUTH_TOKEN env)')
  .option('--database-url <url>', 'Postgres DATABASE_URL (or DATABASE_URL env)')
  .option('--sigma', 'Sync Sigma data (requires Sigma access in Stripe API key)')
  .action(async (options) => {
    await syncCommand({
      stripeKey: options.stripeKey,
      ngrokToken: options.ngrokToken,
      databaseUrl: options.databaseUrl,
      enableSigma: options.sigma,
    })
  })

// Backfill command
program
  .command('backfill <entityName>')
  .description('Backfill a specific entity type from Stripe (e.g., customer, invoice, product)')
  .option('--stripe-key <key>', 'Stripe API key (or STRIPE_API_KEY env)')
  .option('--database-url <url>', 'Postgres DATABASE_URL (or DATABASE_URL env)')
  .option(
    '--sigma',
    'Enable Sigma tables (required for sigma table names like exchange_rates_from_usd)'
  )
  .action(async (entityName, options) => {
    await backfillCommand(
      {
        stripeKey: options.stripeKey,
        databaseUrl: options.databaseUrl,
        enableSigma: options.sigma,
      },
      entityName
    )
  })

// Full sync command
program
  .command('full-sync')
  .description(
    'Re-sync everything from Stripe, skipping if a successful run completed within --interval'
  )
  .option('--stripe-key <key>', 'Stripe API key (or STRIPE_API_KEY env)')
  .option('--database-url <url>', 'Postgres DATABASE_URL (or DATABASE_URL env)')
  .option('--sigma', 'Enable Sigma tables')
  .option(
    '--interval <seconds>',
    'Skip resync if a successful run completed within this many seconds (default: 86400)',
    (val) => parseInt(val, 10)
  )
  .option('--worker-count <count>', 'Number of parallel sync workers (default: 100)', (val) =>
    parseInt(val, 10)
  )
  .option('--rate-limit <limit>', 'Max requests per second (default: 50)', (val) =>
    parseInt(val, 10)
  )
  .action(async (options) => {
    await fullSyncCommand({
      stripeKey: options.stripeKey,
      databaseUrl: options.databaseUrl,
      enableSigma: options.sigma,
      interval: options.interval,
      workerCount: options.workerCount,
      rateLimit: options.rateLimit,
    })
  })

// Monitor command
program
  .command('monitor')
  .description('Live display of table row counts in the stripe schema')
  .option('--database-url <url>', 'Postgres DATABASE_URL (or DATABASE_URL env)')
  .option('--stripe-key <key>', 'Stripe API key (or STRIPE_API_KEY env)')
  .action(async (options) => {
    await monitorCommand({
      databaseUrl: options.databaseUrl,
      stripeKey: options.stripeKey,
    })
  })

// Supabase commands
const supabase = program.command('supabase').description('Supabase Edge Functions commands')

supabase
  .command('install')
  .description('Install Stripe sync to Supabase Edge Functions')
  .option('--token <token>', 'Supabase access token (or SUPABASE_ACCESS_TOKEN env)')
  .option('--project <ref>', 'Supabase project ref (or SUPABASE_PROJECT_REF env)')
  .option('--stripe-key <key>', 'Stripe API key (or STRIPE_API_KEY env)')
  .option(
    '--package-version <version>',
    'Package version to install (e.g., 1.0.8-beta.1, defaults to latest)'
  )
  .option(
    '--worker-interval <seconds>',
    'Worker interval in seconds (defaults to 60)',
    (val) => parseInt(val, 10),
    60
  )
  .option(
    '--management-url <url>',
    'Supabase management API URL with protocol (e.g., http://localhost:54323, defaults to https://api.supabase.com or SUPABASE_MANAGEMENT_URL env)'
  )
  .option('--sigma', 'Enable Sigma sync (deploy sigma worker and cron job)')
  .option(
    '--rate-limit <limit>',
    'Max Stripe API requests per second (default: 60)',
    (val) => parseInt(val, 10),
    60
  )
  .option(
    '--sync-interval <seconds>',
    'How often to run a full resync in seconds (default: 604800 = 1 week)',
    (val) => parseInt(val, 10),
    604800
  )
  .action(async (options) => {
    await installCommand({
      supabaseAccessToken: options.token,
      supabaseProjectRef: options.project,
      stripeKey: options.stripeKey,
      packageVersion: options.packageVersion,
      workerInterval: options.workerInterval,
      syncInterval: options.syncInterval,
      supabaseManagementUrl: options.managementUrl,
      enableSigma: options.sigma,
      rateLimit: options.rateLimit,
    })
  })

supabase
  .command('uninstall')
  .description('Uninstall Stripe sync from Supabase Edge Functions')
  .option('--token <token>', 'Supabase access token (or SUPABASE_ACCESS_TOKEN env)')
  .option('--project <ref>', 'Supabase project ref (or SUPABASE_PROJECT_REF env)')
  .option(
    '--management-url <url>',
    'Supabase management API URL with protocol (e.g., http://localhost:54323, defaults to https://api.supabase.com or SUPABASE_MANAGEMENT_URL env)'
  )
  .action(async (options) => {
    await uninstallCommand({
      supabaseAccessToken: options.token,
      supabaseProjectRef: options.project,
      supabaseManagementUrl: options.managementUrl,
    })
  })

program.parse()
