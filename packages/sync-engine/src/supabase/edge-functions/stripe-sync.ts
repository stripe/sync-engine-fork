/**
 * Consolidated Stripe Sync Edge Function
 *
 * Single Deno.serve() with path-based routing:
 *
 *   POST   /setup     → install (run migrations, create webhook, store secrets)
 *   GET    /setup     → status (installation status + sync runs)
 *   DELETE /setup     → uninstall (drop schema, delete webhooks/secrets/functions)
 *   POST   /webhook   → process Stripe webhook event
 *   POST   /sync      → cron coordinator + backfill workers
 *   POST   /sigma     → sigma data worker
 */

import { StripeSync } from '../../stripeSync.ts'
import { StripeSyncWorker } from '../../stripeSyncWorker.ts'
import { runMigrationsFromContent } from '../../database/migrate.ts'
import { VERSION } from '../../version.ts'
import { embeddedMigrations } from '../../database/migrations-embedded.ts'
import { parseSchemaComment } from '../schemaComment.ts'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// Shared env + helpers (run once per cold start)
// ---------------------------------------------------------------------------

const MGMT_API_BASE_RAW = Deno.env.get('MANAGEMENT_API_URL') || 'https://api.supabase.com'
const MGMT_API_BASE = MGMT_API_BASE_RAW.match(/^https?:\/\//)
  ? MGMT_API_BASE_RAW
  : `https://${MGMT_API_BASE_RAW}`

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

async function deleteEdgeFunction(
  projectRef: string,
  functionSlug: string,
  accessToken: string
): Promise<void> {
  const url = `${MGMT_API_BASE}/v1/projects/${projectRef}/functions/${functionSlug}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok && response.status !== 404) {
    const text = await response.text()
    throw new Error(`Failed to delete function ${functionSlug}: ${response.status} ${text}`)
  }
}

async function deleteSecret(
  projectRef: string,
  secretName: string,
  accessToken: string
): Promise<void> {
  const url = `${MGMT_API_BASE}/v1/projects/${projectRef}/secrets`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([secretName]),
  })

  if (!response.ok && response.status !== 404) {
    const text = await response.text()
    console.warn(`Failed to delete secret ${secretName}: ${response.status} ${text}`)
  }
}

/**
 * Validate worker auth via vault-stored secret.
 * Returns null on success, or an error Response.
 */
async function validateWorkerAuth(
  req: Request,
  sql: ReturnType<typeof postgres>,
  secretName = 'stripe_sync_worker_secret'
): Promise<Response | null> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const token = authHeader.substring(7)

  const vaultResult = await sql`
    SELECT decrypted_secret
    FROM vault.decrypted_secrets
    WHERE name = ${secretName}
  `

  if (vaultResult.length === 0) {
    return new Response(`Worker secret '${secretName}' not configured in vault`, { status: 500 })
  }
  const storedSecret = vaultResult[0].decrypted_secret
  if (token !== storedSecret) {
    return new Response('Forbidden: Invalid worker secret', { status: 403 })
  }

  return null // auth OK
}

// ---------------------------------------------------------------------------
// Route: POST /setup — install (migrations + webhook)
// ---------------------------------------------------------------------------

async function handleSetupPost(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) {
    return jsonResponse({ error: 'SUPABASE_URL not set' }, 500)
  }
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0]

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  let stripeSync = null
  try {
    const dbUrl = Deno.env.get('SUPABASE_DB_URL')
    if (!dbUrl) {
      throw new Error('SUPABASE_DB_URL environment variable is not set')
    }

    const enableSigma = (Deno.env.get('ENABLE_SIGMA') ?? 'false') === 'true'
    const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
    const syncTablesSchemaName = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName
    await runMigrationsFromContent(
      {
        databaseUrl: dbUrl,
        enableSigma,
        stripeApiVersion: Deno.env.get('STRIPE_API_VERSION') ?? '2020-08-27',
        schemaName,
        syncTablesSchemaName,
      },
      embeddedMigrations
    )

    stripeSync = await StripeSync.create({
      poolConfig: { connectionString: dbUrl, max: 2 },
      stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY'),
      schemaName,
      syncTablesSchemaName,
    })

    await stripeSync.postgresClient.query('SELECT pg_advisory_unlock_all()')

    // Webhook URL now points at the consolidated function's /webhook path
    const webhookUrl = `${supabaseUrl}/functions/v1/stripe-sync/webhook`
    const webhook = await stripeSync.webhook.findOrCreateManagedWebhook(webhookUrl)

    await stripeSync.postgresClient.pool.end()

    return jsonResponse({
      success: true,
      message: 'Setup complete',
      webhookId: webhook.id,
      projectRef,
    })
  } catch (error: unknown) {
    const err = error as Error
    console.error('Setup error:', error)
    if (stripeSync) {
      try {
        await stripeSync.postgresClient.query('SELECT pg_advisory_unlock_all()')
        await stripeSync.postgresClient.pool.end()
      } catch (cleanupErr) {
        console.warn('Cleanup failed:', cleanupErr)
      }
    }
    return jsonResponse({ success: false, error: err.message }, 500)
  }
}

// ---------------------------------------------------------------------------
// Route: GET /setup — status
// ---------------------------------------------------------------------------

async function handleSetupGet(_req: Request): Promise<Response> {
  const dbUrl = Deno.env.get('SUPABASE_DB_URL')
  if (!dbUrl) {
    return jsonResponse({ error: 'SUPABASE_DB_URL not set' }, 500)
  }

  let sql: ReturnType<typeof postgres> | undefined

  try {
    sql = postgres(dbUrl, { max: 1, prepare: false })

    const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
    const commentResult = await sql`
      SELECT obj_description(oid, 'pg_namespace') as comment
      FROM pg_namespace
      WHERE nspname = ${schemaName}
    `

    const comment = commentResult[0]?.comment || null

    let syncStatus: Array<Record<string, unknown>> = []
    if (comment) {
      try {
        const syncSchema = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName
        const safeSchema = syncSchema.replace(/"/g, '""')
        syncStatus = await sql.unsafe(`
          SELECT DISTINCT ON (account_id)
            account_id, started_at, closed_at, status, error_message,
            total_processed, total_objects, complete_count, error_count,
            running_count, pending_count, triggered_by, max_concurrent
          FROM "${safeSchema}"."sync_runs"
          ORDER BY account_id, started_at DESC
        `)
      } catch (err) {
        console.warn('sync_runs query failed (may not exist yet):', err)
      }
    }

    const parsedComment = parseSchemaComment(comment)

    return new Response(
      JSON.stringify({
        package_version: VERSION,
        installation_status: parsedComment.status,
        sync_status: syncStatus,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      }
    )
  } catch (error: unknown) {
    const err = error as Error
    console.error('Status query error:', error)
    return jsonResponse(
      {
        error: err.message,
        package_version: VERSION,
        installation_status: 'not_installed',
      },
      500
    )
  } finally {
    if (sql) await sql.end()
  }
}

// ---------------------------------------------------------------------------
// Route: DELETE /setup — uninstall
// ---------------------------------------------------------------------------

async function handleSetupDelete(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) {
    return jsonResponse({ error: 'SUPABASE_URL not set' }, 500)
  }
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0]

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }
  const accessToken = authHeader.substring(7)

  let stripeSync = null
  try {
    const dbUrl = Deno.env.get('SUPABASE_DB_URL')
    if (!dbUrl) {
      throw new Error('SUPABASE_DB_URL environment variable is not set')
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    if (!stripeKey) {
      throw new Error('STRIPE_SECRET_KEY environment variable is required for uninstall')
    }

    const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
    const syncTablesSchemaName = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName
    stripeSync = await StripeSync.create({
      poolConfig: { connectionString: dbUrl, max: 2 },
      stripeSecretKey: stripeKey,
      schemaName,
      syncTablesSchemaName,
    })

    // Delete all managed webhooks
    try {
      const webhooks = await stripeSync.webhook.listManagedWebhooks()
      for (const webhook of webhooks) {
        try {
          await stripeSync.webhook.deleteManagedWebhook(webhook.id)
          console.log(`Deleted webhook: ${webhook.id}`)
        } catch (err) {
          console.warn(`Could not delete webhook ${webhook.id}:`, err)
        }
      }
    } catch (err) {
      console.warn(`Could not get webhooks:`, err)
    }

    // Unschedule pg_cron jobs
    try {
      await stripeSync.postgresClient.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stripe-sync-worker') THEN
            PERFORM cron.unschedule('stripe-sync-worker');
          END IF;
          IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stripe-sigma-worker') THEN
            PERFORM cron.unschedule('stripe-sigma-worker');
          END IF;
        END $$;
      `)
    } catch (err) {
      console.warn('Could not unschedule pg_cron job:', err)
    }

    // Delete vault secrets
    try {
      await stripeSync.postgresClient.query(`
        DELETE FROM vault.secrets
        WHERE name IN ('stripe_sync_worker_secret', 'stripe_sigma_worker_secret')
      `)
    } catch (err) {
      console.warn('Could not delete vault secret:', err)
    }

    // Drop Sigma self-trigger function if present
    try {
      const dropSchema = syncTablesSchemaName.replace(/"/g, '""')
      await stripeSync.postgresClient.query(
        `DROP FUNCTION IF EXISTS "${dropSchema}".trigger_sigma_worker()`
      )
    } catch (err) {
      console.warn('Could not drop sigma trigger function:', err)
    }

    // Terminate connections holding locks on schema
    try {
      await stripeSync.postgresClient.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_locks l
         JOIN pg_class c ON l.relation = c.oid
         JOIN pg_namespace n ON c.relnamespace = n.oid
         WHERE n.nspname = $1 AND l.pid != pg_backend_pid()`,
        [syncTablesSchemaName]
      )
    } catch (err) {
      console.warn('Could not terminate connections:', err)
    }

    // Drop schema(s) with retry
    const schemasToDrop = [...new Set([schemaName, syncTablesSchemaName])]
    let dropAttempts = 0
    const maxAttempts = 3
    while (dropAttempts < maxAttempts) {
      try {
        for (const s of schemasToDrop) {
          const safe = s.replace(/"/g, '""')
          await stripeSync.postgresClient.query(`DROP SCHEMA IF EXISTS "${safe}" CASCADE`)
        }
        break
      } catch (err: unknown) {
        const error = err as Error
        dropAttempts++
        if (dropAttempts >= maxAttempts) {
          throw new Error(
            `Failed to drop schema after ${maxAttempts} attempts. ` +
              `There may be active connections or locks on the stripe schema. ` +
              `Error: ${error.message}`
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }

    await stripeSync.postgresClient.pool.end()

    // Delete Supabase secrets
    try {
      await deleteSecret(projectRef, 'STRIPE_SECRET_KEY', accessToken)
    } catch (err) {
      console.warn('Could not delete STRIPE_SECRET_KEY secret:', err)
    }
    try {
      await deleteSecret(projectRef, 'MANAGEMENT_API_URL', accessToken)
    } catch (err) {
      console.warn('Could not delete MANAGEMENT_API_URL secret:', err)
    }
    try {
      await deleteSecret(projectRef, 'ENABLE_SIGMA', accessToken)
    } catch (err) {
      console.warn('Could not delete ENABLE_SIGMA secret:', err)
    }

    // Delete edge functions (current + legacy from before consolidation)
    for (const slug of [
      'stripe-sync',
      'stripe-setup',
      'stripe-webhook',
      'stripe-worker',
      'sigma-data-worker',
    ]) {
      try {
        await deleteEdgeFunction(projectRef, slug, accessToken)
      } catch (err) {
        console.warn(`Could not delete ${slug} function:`, err)
      }
    }

    return jsonResponse({ success: true, message: 'Uninstall complete' })
  } catch (error: unknown) {
    const err = error as Error
    console.error('Uninstall error:', error)
    if (stripeSync) {
      try {
        await stripeSync.postgresClient.pool.end()
      } catch (cleanupErr) {
        console.warn('Cleanup failed:', cleanupErr)
      }
    }
    return jsonResponse({ success: false, error: err.message }, 500)
  }
}

// ---------------------------------------------------------------------------
// Route: POST /webhook — process Stripe webhook event
// ---------------------------------------------------------------------------

async function handleWebhook(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const sig = req.headers.get('stripe-signature')
  if (!sig) {
    return new Response('Missing stripe-signature header', { status: 400 })
  }

  const dbUrl = Deno.env.get('SUPABASE_DB_URL')
  const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
  const syncTablesSchemaName = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName
  if (!dbUrl) {
    return jsonResponse({ error: 'SUPABASE_DB_URL not set' }, 500)
  }

  const stripeSync = await StripeSync.create({
    poolConfig: { connectionString: dbUrl, max: 1 },
    stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
    partnerId: 'pp_supabase',
    schemaName,
    syncTablesSchemaName,
  })

  try {
    const rawBody = new Uint8Array(await req.arrayBuffer())
    await stripeSync.webhook.processWebhook(rawBody, sig)
    return jsonResponse({ received: true })
  } catch (error: unknown) {
    const err = error as Error & { type?: string }
    console.error('Webhook processing error:', error)
    const isSignatureError =
      err.message?.includes('signature') || err.type === 'StripeSignatureVerificationError'
    const status = isSignatureError ? 400 : 500
    return jsonResponse({ error: err.message }, status)
  } finally {
    await stripeSync.postgresClient.pool.end()
  }
}

// ---------------------------------------------------------------------------
// Route: POST /sync — cron coordinator + backfill workers
// ---------------------------------------------------------------------------

// Module-level state for worker (reused between requests)
const syncDbUrl = Deno.env.get('SUPABASE_DB_URL')
const SYNC_INTERVAL = Number(Deno.env.get('SYNC_INTERVAL')) || 60 * 60 * 24 * 7
const syncRateLimit = Number(Deno.env.get('RATE_LIMIT')) || 25
const syncWorkerCount = Number(Deno.env.get('WORKER_COUNT')) || 10
const syncSchemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
const syncTablesSchemaName = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? syncSchemaName

// Lazily initialized on first /sync request
let syncSql: ReturnType<typeof postgres> | undefined
let syncStripeSync: StripeSync | undefined
let syncObjects: string[] | undefined
let syncTableNames: string[] | undefined

async function ensureSyncInitialized(): Promise<void> {
  if (syncStripeSync) return
  if (!syncDbUrl) throw new Error('SUPABASE_DB_URL secret not configured')

  syncSql = postgres(syncDbUrl, { max: 1, prepare: false })
  syncStripeSync = await StripeSync.create({
    poolConfig: { connectionString: syncDbUrl, max: 1 },
    stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
    enableSigma: false,
    partnerId: 'pp_supabase',
    schemaName: syncSchemaName,
    syncTablesSchemaName,
  })
  syncObjects = syncStripeSync.getSupportedSyncObjects()
  const registry = syncStripeSync.resourceRegistry
  syncTableNames = syncObjects.map((obj: keyof typeof registry) => registry[obj].tableName)
}

async function handleSync(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  await ensureSyncInitialized()
  const sql = syncSql!
  const stripeSync = syncStripeSync!
  const objects = syncObjects!
  const tableNames = syncTableNames!

  // Validate worker auth via vault
  const authErr = await validateWorkerAuth(req, sql)
  if (authErr) return authErr

  const runKey = await stripeSync.reconciliationSync(
    objects,
    tableNames,
    true,
    'edge-worker',
    SYNC_INTERVAL
  )
  if (runKey === null) {
    const activeSkipResult = await sql`SELECT decrypted_secret::timestamptz::text AS skip_until
      FROM vault.decrypted_secrets
      WHERE name = 'stripe_sync_skip_until'
        AND decrypted_secret::timestamptz >= NOW()
      LIMIT 1`

    let skipUntil = activeSkipResult[0]?.skip_until
    if (!skipUntil) {
      skipUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      await sql`DELETE FROM vault.secrets WHERE name = 'stripe_sync_skip_until'`
      await sql`SELECT vault.create_secret(
        ${skipUntil},
        'stripe_sync_skip_until'
      )`
    }
    const completedRun = await stripeSync.postgresClient.getCompletedRun(
      stripeSync.accountId,
      SYNC_INTERVAL
    )
    const message = `Skipping resync — a successful run completed at ${completedRun?.runStartedAt.toISOString()} (within ${SYNC_INTERVAL}s window). Cron paused until ${skipUntil}.`
    console.log(message)
    return jsonResponse({ skipped: true, message })
  }
  await stripeSync.postgresClient.resetStuckRunningObjects(runKey.accountId, runKey.runStartedAt, 1)

  const workers = Array.from(
    { length: syncWorkerCount },
    () =>
      new StripeSyncWorker(
        stripeSync.stripe,
        stripeSync.config,
        stripeSync.sigma,
        stripeSync.postgresClient,
        stripeSync.accountId,
        stripeSync.resourceRegistry,
        stripeSync.sigmaRegistry,
        runKey,
        stripeSync.upsertAny.bind(stripeSync),
        Infinity,
        syncRateLimit
      )
  )
  // 20s budget leaves ~10s headroom before Supabase's ~30s edge function limit.
  // Future optimizations:
  // - Make the initial /sync invocation in install() fire-and-forget so install
  //   returns faster (currently blocks for up to 20s waiting for first batch).
  // - Tune MAX_EXECUTION_MS based on observed cold-start times.
  // - Consider returning a streaming response so the caller can observe progress.
  const MAX_EXECUTION_MS = 20_000
  workers.forEach((worker) => worker.start())
  const allDone = await Promise.race([
    Promise.all(workers.map((w) => w.waitUntilDone())).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), MAX_EXECUTION_MS)),
  ])
  workers.forEach((w) => w.shutdown())
  const totals = await stripeSync.postgresClient.getObjectSyncedCounts(
    stripeSync.accountId,
    runKey.runStartedAt
  )
  const totalSynced = (Object.values(totals) as number[]).reduce(
    (sum: number, n: number) => sum + n,
    0
  )
  console.log(`Finished: ${totalSynced} objects synced`, totals)

  // Self-reinvoke if there's still pending work (fire-and-forget)
  let selfReinvoked = false
  if (!allDone) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    if (supabaseUrl) {
      const authHeader = req.headers.get('Authorization')
      try {
        // Fire-and-forget: don't await
        fetch(`${supabaseUrl}/functions/v1/stripe-sync/sync`, {
          method: 'POST',
          headers: {
            ...(authHeader ? { Authorization: authHeader } : {}),
            'Content-Type': 'application/json',
          },
        }).catch((err) => console.warn('Self-reinvoke fetch failed:', err))
        selfReinvoked = true
        console.log('Self-reinvoked /sync for remaining work')
      } catch (err) {
        console.warn('Failed to self-reinvoke:', err)
      }
    }
  }

  return jsonResponse({ totals, selfReinvoked })
}

// ---------------------------------------------------------------------------
// Route: POST /sigma — sigma data worker
// ---------------------------------------------------------------------------

const SIGMA_BATCH_SIZE = 1
const SIGMA_MAX_RUN_AGE_MS = 6 * 60 * 60 * 1000

async function handleSigma(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const dbUrl = Deno.env.get('SUPABASE_DB_URL')
  if (!dbUrl) {
    return jsonResponse({ error: 'SUPABASE_DB_URL not set' }, 500)
  }
  const schemaName = Deno.env.get('SYNC_SCHEMA_NAME') ?? 'stripe'
  const sigmaTablesSchemaName = Deno.env.get('SYNC_TABLES_SCHEMA_NAME') ?? schemaName
  const safeSyncSchema = sigmaTablesSchemaName.replace(/"/g, '""')

  let sql: ReturnType<typeof postgres> | undefined
  let stripeSync: StripeSync | undefined

  try {
    sql = postgres(dbUrl, { max: 1, prepare: false })
  } catch (error: unknown) {
    const err = error as Error
    return jsonResponse(
      { error: 'Failed to create postgres connection', details: err.message },
      500
    )
  }

  try {
    // Validate the token against vault secret
    const authErr = await validateWorkerAuth(req, sql, 'stripe_sigma_worker_secret')
    if (authErr) {
      await sql.end()
      return authErr
    }

    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY')
    if (!stripeSecretKey) {
      return jsonResponse({ error: 'STRIPE_SECRET_KEY not set' }, 500)
    }

    stripeSync = await StripeSync.create({
      poolConfig: { connectionString: dbUrl, max: 1 },
      stripeSecretKey,
      enableSigma: true,
      sigmaPageSizeOverride: 1000,
      schemaName,
      syncTablesSchemaName: sigmaTablesSchemaName,
    })
  } catch (error: unknown) {
    const err = error as Error
    await sql.end()
    return jsonResponse({ error: 'Failed to create StripeSync', details: err.message }, 500)
  }

  try {
    const accountId = await stripeSync.getAccountId()
    const sigmaObjects = stripeSync.getSupportedSigmaObjects()

    if (sigmaObjects.length === 0) {
      return jsonResponse({ message: 'No Sigma objects configured for sync' })
    }

    const runResult = await stripeSync.postgresClient.getOrCreateSyncRun(accountId, 'sigma-worker')
    const runStartedAt =
      runResult?.runStartedAt ??
      (await stripeSync.postgresClient.getActiveSyncRun(accountId, 'sigma-worker'))?.runStartedAt

    if (!runStartedAt) {
      throw new Error('Failed to get or create sync run for sigma worker')
    }

    // Legacy cleanup
    await stripeSync.postgresClient.query(
      `UPDATE "${safeSyncSchema}"."_sync_obj_runs"
       SET status = 'error',
           error_message = 'Legacy sigma worker prefix run (sigma.*); superseded by unprefixed runs',
           completed_at = now()
       WHERE "_account_id" = $1
         AND run_started_at = $2
         AND object LIKE 'sigma.%'
         AND status IN ('pending', 'running')`,
      [accountId, runStartedAt]
    )

    const runAgeMs = Date.now() - runStartedAt.getTime()
    if (runAgeMs > SIGMA_MAX_RUN_AGE_MS) {
      console.warn(
        `Sigma worker: run too old (${Math.round(runAgeMs / 1000 / 60)} min), closing without self-trigger`
      )
      await stripeSync.postgresClient.closeSyncRun(accountId, runStartedAt)
      return jsonResponse({
        message: 'Sigma run exceeded max age, closed without processing',
        runAgeMinutes: Math.round(runAgeMs / 1000 / 60),
        selfTriggered: false,
      })
    }

    await stripeSync.postgresClient.createObjectRuns(accountId, runStartedAt, sigmaObjects)
    await stripeSync.postgresClient.ensureSyncRunMaxConcurrent(
      accountId,
      runStartedAt,
      SIGMA_BATCH_SIZE
    )

    const runningObjects = await stripeSync.postgresClient.listObjectsByStatus(
      accountId,
      runStartedAt,
      'running',
      sigmaObjects
    )

    const objectsToProcess = runningObjects.slice(0, SIGMA_BATCH_SIZE)
    let pendingObjects: string[] = []

    if (objectsToProcess.length === 0) {
      pendingObjects = await stripeSync.postgresClient.listObjectsByStatus(
        accountId,
        runStartedAt,
        'pending',
        sigmaObjects
      )

      for (const objectKey of pendingObjects) {
        if (objectsToProcess.length >= SIGMA_BATCH_SIZE) break
        const started = await stripeSync.postgresClient.tryStartObjectSync(
          accountId,
          runStartedAt,
          objectKey
        )
        if (started) {
          objectsToProcess.push(objectKey)
        }
      }
    }

    if (objectsToProcess.length === 0) {
      if (pendingObjects.length === 0) {
        console.info('Sigma worker: all objects complete or errored - run finished')
        return jsonResponse({ message: 'Sigma sync run complete', selfTriggered: false })
      }

      console.info('Sigma worker: at concurrency limit, will self-trigger', {
        pendingCount: pendingObjects.length,
      })
      let selfTriggered = false
      try {
        await sql.unsafe(`SELECT "${safeSyncSchema}".trigger_sigma_worker()`)
        selfTriggered = true
      } catch (error: unknown) {
        const err = error as Error
        console.warn('Failed to self-trigger sigma worker:', err.message)
      }

      return jsonResponse({
        message: 'At concurrency limit',
        pendingCount: pendingObjects.length,
        selfTriggered,
      })
    }

    const results: Array<Record<string, unknown>> = []

    for (const object of objectsToProcess) {
      const objectKey = object
      try {
        console.info(`Sigma worker: processing ${object}`)

        const result = await stripeSync.processNext(
          object as keyof typeof stripeSync.resourceRegistry,
          {
            runStartedAt,
            triggeredBy: 'sigma-worker',
          }
        )

        results.push({
          object,
          processed: result.processed,
          hasMore: result.hasMore,
          status: 'success',
        })

        if (result.hasMore) {
          console.info(
            `Sigma worker: ${object} has more pages, processed ${result.processed} rows so far`
          )
        } else {
          console.info(`Sigma worker: ${object} complete, processed ${result.processed} rows`)
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error(`Sigma worker: error processing ${object}:`, error)

        await stripeSync.postgresClient.failObjectSync(
          accountId,
          runStartedAt,
          objectKey,
          err.message ?? 'Unknown error'
        )

        results.push({
          object,
          processed: 0,
          hasMore: false,
          status: 'error',
          error: err.message,
        })
      }
    }

    const pendingAfter = await stripeSync.postgresClient.listObjectsByStatus(
      accountId,
      runStartedAt,
      'pending',
      sigmaObjects
    )
    const runningAfter = await stripeSync.postgresClient.listObjectsByStatus(
      accountId,
      runStartedAt,
      'running',
      sigmaObjects
    )

    const remainingMs = SIGMA_MAX_RUN_AGE_MS - (Date.now() - runStartedAt.getTime())
    const remainingMinutes = Math.round(remainingMs / 1000 / 60)

    const shouldSelfTrigger =
      (pendingAfter.length > 0 || runningAfter.length > 0) && remainingMs > 0

    let selfTriggered = false
    if (shouldSelfTrigger) {
      console.info('Sigma worker: more work remains, self-triggering', {
        pending: pendingAfter.length,
        running: runningAfter.length,
        remainingMinutes,
      })
      try {
        await sql.unsafe(`SELECT "${safeSyncSchema}".trigger_sigma_worker()`)
        selfTriggered = true
      } catch (error: unknown) {
        const err = error as Error
        console.warn('Failed to self-trigger sigma worker:', err.message)
      }
    } else if (pendingAfter.length > 0 || runningAfter.length > 0) {
      console.warn('Sigma worker: work remains but run timed out, closing', {
        pending: pendingAfter.length,
        running: runningAfter.length,
      })
      await stripeSync.postgresClient.closeSyncRun(accountId, runStartedAt)
    } else {
      console.info('Sigma worker: no more work, run complete')
    }

    return jsonResponse({
      results,
      selfTriggered,
      remaining: { pending: pendingAfter.length, running: runningAfter.length },
    })
  } catch (error: unknown) {
    const err = error as Error
    console.error('Sigma worker error:', error)
    return jsonResponse({ error: err.message, stack: err.stack }, 500)
  } finally {
    if (sql) await sql.end()
    if (stripeSync) await stripeSync.postgresClient.pool.end()
  }
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  const url = new URL(req.url)
  // Last segment after /functions/v1/stripe-sync/
  const path = url.pathname.split('/').pop()

  if (path === 'webhook') return handleWebhook(req)

  if (path === 'setup') {
    if (req.method === 'GET') return handleSetupGet(req)
    if (req.method === 'POST') return handleSetupPost(req)
    if (req.method === 'DELETE') return handleSetupDelete(req)
    return new Response('Method not allowed', { status: 405 })
  }

  if (path === 'sync') return handleSync(req)
  if (path === 'sigma') return handleSigma(req)

  return new Response('Not found', { status: 404 })
})
