import type { WorkflowStatus } from '../../lib/createSchemas.js'
import type { ActivitiesContext } from './_shared.js'

export function createUpdatePipelineStatusActivity(context: ActivitiesContext) {
  return async function updatePipelineStatus(
    pipelineId: string,
    workflowStatus: WorkflowStatus
  ): Promise<void> {
    try {
      await context.pipelineStore.update(pipelineId, { status: workflowStatus })
    } catch {
      // Pipeline may have been removed — no-op
    }
  }
}
