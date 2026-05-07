import { heartbeat } from '@temporalio/activity'
import { createStripeSource, type Config as StripeSourceConfig } from '@stripe/sync-source-stripe'
import destinationPostgres, {
  type Config as PostgresDestConfig,
} from '@stripe/sync-destination-postgres'
import destinationSheets, {
  type Config as SheetsDestConfig,
} from '@stripe/sync-destination-google-sheets'
import type { Destination } from '@stripe/sync-protocol'
import type { ActivitiesContext } from './_shared.js'
import { log } from '../../logger.js'

type SupportedDestType = 'postgres' | 'google_sheets'

function resolveDestination(
  type: string
): { destination: Destination<Record<string, unknown>>; type: SupportedDestType } | undefined {
  if (type === 'postgres') {
    return { destination: destinationPostgres as Destination<Record<string, unknown>>, type }
  }
  if (type === 'google_sheets') {
    return { destination: destinationSheets as Destination<Record<string, unknown>>, type }
  }
  return undefined
}

export function createReconcileCleanupActivity(context: ActivitiesContext) {
  return async function reconcileCleanup(
    pipelineId: string,
    syncRunStartedAt: string
  ): Promise<void> {
    const pipeline = await context.pipelineStore.get(pipelineId)
    const { source, destination, streams } = pipeline

    if (source.type !== 'stripe') {
      // Only stripe sources support verifyRecords today.
      return
    }
    const resolved = resolveDestination(destination.type)
    if (!resolved) {
      // Destination doesn't implement getStaleRecords yet.
      return
    }

    // Configs were validated against connector schemas at pipeline create time,
    // so the runtime shape matches each connector's strict Config type.
    const sourceConfig = source[source.type] as unknown as StripeSourceConfig
    const destConfig = destination[destination.type] as unknown as
      | PostgresDestConfig
      | SheetsDestConfig

    const catalog = {
      streams:
        streams?.map((s) => ({
          stream: { name: s.name, newer_than_field: '_updated_at', primary_key: [['id']] },
          sync_mode: s.sync_mode || 'incremental',
          destination_sync_mode: 'append_dedup' as const,
        })) ?? [],
    }
    if (catalog.streams.length === 0) return

    // Restrict cleanup to records owned by this Stripe account so multi-tenant
    // schemas don't accidentally hard-delete rows that belong to a sibling sync.
    const filter = sourceConfig.account_id ? { _account_id: sourceConfig.account_id } : undefined
    if (!filter) {
      log.warn(
        { pipelineId, destinationType: resolved.type },
        'reconcile_cleanup: source has no account_id — running unscoped (unsafe in multi-tenant schemas)'
      )
    }

    const stripeSource = createStripeSource()
    const dest = resolved.destination
    // Guaranteed by `resolveDestination`'s whitelist: every type that resolves
    // here is a destination that ships a `getStaleRecords` implementation.
    const getStaleRecords = dest.getStaleRecords!

    try {
      heartbeat({ phase: 'starting', pipelineId, destinationType: resolved.type })

      // Wrap the destination's batches so we heartbeat per stream.
      async function* heartbeatedStaleRecords() {
        const inner = getStaleRecords({
          config: destConfig as Record<string, unknown>,
          catalog,
          syncRunStartedAt,
          filter,
        })
        for await (const batch of inner) {
          heartbeat({ phase: 'verifying', stream: batch.stream, ids: batch.ids.length })
          yield batch
        }
      }

      const verificationMessages = stripeSource.verifyRecords!(
        { config: sourceConfig, catalog },
        heartbeatedStaleRecords()
      )

      const writeOutput = dest.write(
        { config: destConfig as Record<string, unknown>, catalog },
        verificationMessages
      )

      let deleteCount = 0
      let lastHb = Date.now()
      for await (const m of writeOutput) {
        if (m.type === 'record' && m.record.recordDeleted) deleteCount++
        if (Date.now() - lastHb >= 15_000) {
          heartbeat({ phase: 'writing', deletes: deleteCount })
          lastHb = Date.now()
        }
      }

      log.info(
        { pipelineId, destinationType: resolved.type, deleteCount, syncRunStartedAt },
        'reconcile_cleanup: completed'
      )
    } catch (err) {
      // Cleanup is best-effort — log and swallow so the workflow's reconcile
      // loop keeps running on the next interval.
      log.error({ err, pipelineId, syncRunStartedAt }, 'reconcile_cleanup: failed')
    }
  }
}
