import { applySelection, buildCatalog } from '@stripe/sync-engine'
import type { ConfiguredCatalog } from '@stripe/sync-engine'
import { collectFirst } from '@stripe/sync-protocol'
import type { Message } from '@stripe/sync-protocol'

import type { ActivitiesContext } from './_shared.js'

export function createDiscoverCatalogActivity(context: ActivitiesContext) {
  return async function discoverCatalog(pipelineId: string): Promise<ConfiguredCatalog> {
    const pipeline = await context.pipelines.get(pipelineId)
    const { id: _, ...config } = pipeline
    const catalogMsg = await collectFirst(
      context.engine.source_discover(config.source),
      'catalog'
    )
    return applySelection(buildCatalog(catalogMsg.catalog.streams, config.streams))
  }
}
