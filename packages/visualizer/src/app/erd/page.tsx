'use client'

/**
 * ERD Visualizer Page
 * Full-screen ERD visualization of the loaded PGlite schema
 */

import { usePGlite } from '@/lib/pglite'
import { useProjection } from '@/lib/useProjection'
import { useVersionIndex } from '@/lib/useVersionIndex'
import ERDCanvas from '@/components/ERDCanvas'

export default function ERDPage() {
  const { versionIndex, status: versionIndexStatus, error: versionIndexError } = useVersionIndex()
  const resolvedVersion = versionIndex?.defaultVersion ?? null
  const { db, status, error, manifest } = usePGlite({ version: resolvedVersion })
  const {
    projectedModel,
    config: projectionConfig,
    setConfig: setProjectionConfig,
    loadingState: projectionLoadingState,
    artifact: projectionArtifact,
  } = useProjection({
    version: resolvedVersion,
  })

  if (versionIndexStatus === 'error') {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-6 text-center">
          <h3 className="mb-2 text-lg font-semibold text-red-900">Version Index Error</h3>
          <p className="text-sm text-red-700">{versionIndexError || 'Failed to load versions'}</p>
        </div>
      </div>
    )
  }

  if (versionIndexStatus === 'loading' || (!!resolvedVersion && status !== 'ready' && !db)) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-slate-300 border-t-indigo-600 mx-auto" />
          <p className="text-sm font-medium text-slate-700">Loading database...</p>
        </div>
      </div>
    )
  }

  if (status === 'error' || error) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-6 text-center">
          <h3 className="mb-2 text-lg font-semibold text-red-900">Database Error</h3>
          <p className="text-sm text-red-700">{error || 'Failed to load database'}</p>
        </div>
      </div>
    )
  }

  if (!db) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <p className="text-sm text-slate-600">Database not initialized</p>
      </div>
    )
  }

  return (
    <ERDCanvas
      db={db}
      manifest={manifest}
      projectedModel={projectedModel}
      projectionConfig={projectionConfig}
      onProjectionConfigChange={setProjectionConfig}
      projectionLoadingState={projectionLoadingState}
      projectionArtifact={projectionArtifact}
    />
  )
}
