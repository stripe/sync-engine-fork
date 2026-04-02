import type { WorkflowClient } from '@temporalio/client'
import type { Pipeline } from '../lib/schemas.js'
import type { WorkflowStatus } from './types.js'

// MARK: - Types

export interface TemporalOptions {
  client: WorkflowClient
  taskQueue: string
}

// MARK: - TemporalBridge

/** Bridge between the service API and Temporal workflows. */
export class TemporalBridge {
  constructor(
    private client: WorkflowClient,
    private taskQueue: string
  ) {}

  /** Deterministic workflow ID for a given pipeline. */
  private workflowId(pipelineId: string): string {
    return `pipe_${pipelineId}`
  }

  /**
   * Start a `pipelineWorkflow` for the given pipeline.
   * Stores the full pipeline in workflow memo for list visibility.
   */
  async start(
    pipeline: Pipeline,
    opts?: { mode?: 'sync' | 'read-write'; writeRps?: number }
  ): Promise<void> {
    await this.client.start('pipelineWorkflow', {
      workflowId: this.workflowId(pipeline.id),
      taskQueue: this.taskQueue,
      args: [pipeline, opts],
      memo: { pipeline },
    })
  }

  /** List all pipeline workflows via the Temporal visibility API. */
  async list(): Promise<Pipeline[]> {
    const pipelines: Pipeline[] = []
    for await (const workflow of this.client.list({
      query: `WorkflowType = 'pipelineWorkflow'`,
    })) {
      const memo = workflow.memo as { pipeline?: Pipeline } | undefined
      if (memo?.pipeline) {
        pipelines.push(memo.pipeline)
      }
    }
    return pipelines
  }

  /** Get pipeline config + status by querying the workflow. */
  async get(pipelineId: string): Promise<{ pipeline: Pipeline; status: WorkflowStatus }> {
    const handle = this.client.getHandle(this.workflowId(pipelineId))
    const [pipeline, status] = await Promise.all([
      handle.query<Pipeline>('config'),
      handle.query<WorkflowStatus>('status'),
    ])
    return { pipeline, status }
  }

  /** Signal the workflow to update config (includes pause/resume via { paused }). */
  async update(pipelineId: string, patch: Partial<Pipeline> & { paused?: boolean }): Promise<void> {
    const handle = this.client.getHandle(this.workflowId(pipelineId))
    await handle.signal('update', patch)
  }

  /** Signal the workflow to delete (triggers teardown + exit). */
  async stop(pipelineId: string): Promise<void> {
    const handle = this.client.getHandle(this.workflowId(pipelineId))
    try {
      await handle.signal('delete')
    } catch {
      // Workflow may already be completed — ignore signal failures
    }
  }

  /** Push a webhook event to the pipeline's Temporal workflow. */
  pushEvent(pipelineId: string, event: unknown): void {
    const handle = this.client.getHandle(this.workflowId(pipelineId))
    handle.signal('stripe_event', event).catch(() => {
      // Workflow may not be running — ignore signal failures
    })
  }
}
