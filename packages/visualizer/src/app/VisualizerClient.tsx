'use client'

/**
 * Visualizer Client
 *
 * Main client-side component for the ERD visualizer.
 */

import React, { useState } from 'react'
import dynamic from 'next/dynamic'
import { usePGlite } from '@/lib/pglite'
import { useProjection } from '@/lib/useProjection'
import { useVersionIndex } from '@/lib/useVersionIndex'
import VersionPicker from '@/components/VersionPicker'

// Dynamically import heavy components to optimize initial load
const ERDCanvas = dynamic(() => import('@/components/ERDCanvas'), {
  ssr: false,
  loading: () => <CanvasLoadingSkeleton message="Loading ERD canvas..." />,
})

export default function VisualizerClient() {
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
  const { versionIndex, status: versionIndexStatus, error: versionIndexError } = useVersionIndex()
  const resolvedVersion = selectedVersion ?? versionIndex?.defaultVersion ?? null
  const { db, status, error, manifest, version } = usePGlite({
    version: resolvedVersion,
  })
  const {
    projectedModel,
    config: projectionConfig,
    setConfig: setProjectionConfig,
    loadingState: projectionLoadingState,
    artifact: projectionArtifact,
  } = useProjection({
    version: resolvedVersion,
  })

  const isInitialLoad =
    versionIndexStatus === 'loading' || (!!resolvedVersion && status !== 'ready' && !db)
  const isVersionSwitching = status === 'loading' && db !== null

  /**
   * Render error state
   */
  if (status === 'error') {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-white">
        <div className="flex max-w-lg flex-col items-center gap-3 rounded-2xl border border-red-200 bg-white px-8 py-7 text-center shadow-sm">
          <span className="text-4xl">⚠️</span>
          <h2 className="text-lg font-semibold text-slate-950">Database Error</h2>
          <p className="text-sm text-slate-600">{error}</p>
        </div>
      </div>
    )
  }

  /**
   * Render initial loading state (no database yet)
   */
  if (isInitialLoad) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-white">
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-slate-200 bg-white px-8 py-7 shadow-sm">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-600" />
          <p className="text-sm text-slate-500">Loading database...</p>
        </div>
      </div>
    )
  }

  if (versionIndexStatus === 'error') {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-white">
        <div className="flex max-w-lg flex-col items-center gap-3 rounded-2xl border border-red-200 bg-white px-8 py-7 text-center shadow-sm">
          <span className="text-4xl">⚠️</span>
          <h2 className="text-lg font-semibold text-slate-950">Version Index Error</h2>
          <p className="text-sm text-slate-600">{versionIndexError}</p>
        </div>
      </div>
    )
  }

  /**
   * Render main visualizer
   */
  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-6">
            <div>
              <h1 className="text-lg font-semibold text-slate-900">Schema Visualizer</h1>
              <p className="text-xs text-slate-500">
                {manifest ? `${manifest.totalTables} tables loaded in ERD view` : 'ERD ready'}
              </p>
            </div>

            <VersionPicker
              versionIndex={versionIndex}
              selectedVersion={resolvedVersion ?? version}
              onVersionChange={setSelectedVersion}
              className="ml-2"
            />
          </div>
        </div>
      </header>

      <main className="relative flex-1 overflow-hidden">
        {isVersionSwitching && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900/20 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-4 rounded-2xl border border-slate-200 bg-white px-8 py-7 shadow-xl">
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-600" />
              <p className="text-sm font-medium text-slate-700">Switching version...</p>
              <p className="text-xs text-slate-500">
                {version ? `Loading ${version}` : 'Initializing database'}
              </p>
            </div>
          </div>
        )}

        <div className="h-full w-full">
          {db && (
            <ERDCanvas
              key={version || 'default'}
              db={db}
              manifest={manifest}
              projectedModel={projectedModel}
              projectionConfig={projectionConfig}
              onProjectionConfigChange={setProjectionConfig}
              projectionLoadingState={projectionLoadingState}
              projectionArtifact={projectionArtifact}
            />
          )}
        </div>
      </main>
    </div>
  )
}

/**
 * Loading skeleton for the ERD canvas
 */
function CanvasLoadingSkeleton({ message }: { message: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-600" />
        <p className="text-sm text-slate-500">{message}</p>
      </div>
    </div>
  )
}
