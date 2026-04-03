import { defineQuery, defineSignal, proxyActivities } from '@temporalio/workflow'

import type { SyncActivities } from '../activities.js'
import { retryPolicy } from '../../lib/utils.js'

export interface WorkflowStatus {
  phase: string
  paused: boolean
  iteration: number
}

type SyncMode = 'incremental' | 'full_refresh'

interface StreamDef {
  name: string
  sync_mode?: SyncMode
  fields?: string[]
}

export interface Pipeline {
  id: string
  source: { type: string; [key: string]: unknown }
  destination: { type: string; [key: string]: unknown }
  streams?: StreamDef[]
}

export type PipelineConfig = {
  source: { type: string; [key: string]: unknown }
  destination: { type: string; [key: string]: unknown }
  streams?: StreamDef[]
}

export type RowIndex = Record<string, Record<string, number>>

export function toConfig(pipeline: Pipeline): PipelineConfig {
  return {
    source: pipeline.source,
    destination: pipeline.destination,
    streams: pipeline.streams,
  }
}

export const stripeEventSignal = defineSignal<[unknown]>('stripe_event')
export const updateSignal = defineSignal<[Partial<Pipeline>]>('update')
export const deleteSignal = defineSignal('delete')

export const statusQuery = defineQuery<WorkflowStatus>('status')
export const configQuery = defineQuery<Pipeline>('config')
export const stateQuery = defineQuery<Record<string, unknown>>('state')

export const { setup, teardown } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '2m',
  retry: retryPolicy,
})

export const { syncImmediate, readIntoQueue, writeFromQueue } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

export const { discoverCatalog, readIntoQueueWithState, writeGoogleSheetsFromQueue } =
  proxyActivities<SyncActivities>({
    startToCloseTimeout: '10m',
    heartbeatTimeout: '2m',
    retry: retryPolicy,
  })
