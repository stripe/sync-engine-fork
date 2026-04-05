import { collectMessages } from '@stripe/sync-protocol'

import type { ActivitiesContext } from './_shared.js'

export function createSetupActivity(context: ActivitiesContext) {
  return async function setup(pipelineId: string): Promise<void> {
    const pipeline = await context.pipelineStore.get(pipelineId)
    const { id: _, ...config } = pipeline
    const { messages: controlMsgs } = await collectMessages(
      context.engine.pipeline_setup(config),
      'control'
    )
    const sourceConfigs = controlMsgs.flatMap((m) =>
      m.control.control_type === 'source_config' ? [m.control.source_config] : []
    )
    const destConfigs = controlMsgs.flatMap((m) =>
      m.control.control_type === 'destination_config' ? [m.control.destination_config] : []
    )
    const patch: Record<string, unknown> = {}
    if (sourceConfigs.length > 0)
      patch.source = { ...pipeline.source, ...Object.assign({}, ...sourceConfigs) }
    if (destConfigs.length > 0)
      patch.destination = { ...pipeline.destination, ...Object.assign({}, ...destConfigs) }
    if (Object.keys(patch).length > 0) {
      await context.pipelineStore.update(pipelineId, patch)
    }
  }
}
