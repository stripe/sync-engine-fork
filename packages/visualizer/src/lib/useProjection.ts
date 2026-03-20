/**
 * useProjection React Hook
 *
 * Manages the full projection lifecycle for ERD visualization:
 * 1. Fetches projection.json for the current API version
 * 2. Holds ProjectionConfig state with sensible defaults
 * 3. Calls projection engine to derive visible ERD model
 * 4. Exposes derived model, config, capabilities, and loading state
 *
 * This hook is the single source of truth for projection state in the ERD.
 *
 * Usage:
 *   const { projectedModel, config, setConfig, capabilities, isLoading, error } =
 *     useProjection({ version: '2023-10-16' })
 *
 *   if (isLoading) return <Spinner />
 *   if (error) return <ErrorMessage error={error} />
 *
 *   <ERDCanvas model={projectedModel} />
 *   <ProjectionControls config={config} onChange={setConfig} capabilities={capabilities} />
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { ProjectionArtifact, ProjectionConfig, VersionCapabilities } from '@/types/projection'
import { DEFAULT_PROJECTION_CONFIG } from '@/types/projection'
import { deriveProjectedModel, type ProjectedERDModel } from './projection-engine'

/**
 * Hook options
 */
export interface UseProjectionOptions {
  /**
   * API version to load projection for (e.g., '2023-10-16')
   * If not provided, no projection artifact will be loaded
   */
  version?: string | null

  /**
   * Initial projection config
   * If not provided, uses DEFAULT_PROJECTION_CONFIG
   */
  initialConfig?: Partial<ProjectionConfig>
}

/**
 * Hook return value
 */
export interface UseProjectionResult {
  /**
   * The derived ERD model ready for visualization
   * Null when loading or artifact unavailable
   */
  projectedModel: ProjectedERDModel | null

  /**
   * Current projection configuration state
   */
  config: ProjectionConfig

  /**
   * Update projection configuration
   * Triggers re-derivation without PGlite re-hydration
   */
  setConfig: (config: ProjectionConfig | ((prev: ProjectionConfig) => ProjectionConfig)) => void

  /**
   * Version capabilities from the artifact
   * Null when loading or artifact unavailable
   */
  capabilities: VersionCapabilities | null

  /**
   * Loading state
   * - 'idle': No version specified
   * - 'loading': Fetching projection.json
   * - 'ready': Artifact loaded and model derived
   * - 'fallback': No projection.json found, using fallback mode
   */
  loadingState: 'idle' | 'loading' | 'ready' | 'fallback'

  /**
   * Error message if fetch failed (excluding 404 which triggers fallback)
   */
  error: string | null

  /**
   * The raw projection artifact (for debugging/advanced use)
   */
  artifact: ProjectionArtifact | null
}

/**
 * Fallback capabilities when projection.json is missing
 * Assumes basic v1 schema with raw timestamps
 */
const FALLBACK_CAPABILITIES: VersionCapabilities = {
  hasV2Namespace: false,
  hasExplicitForeignKeys: false,
  hasDeletedVariants: false,
  hasListEndpointMetadata: false,
  hasWebhookEventMetadata: false,
  timestampFormat: 'raw',
  tableCount: 0,
  relationshipCount: 0,
}

/**
 * Fallback artifact when projection.json is missing
 * Returns an empty artifact structure for full-schema mode
 */
function createFallbackArtifact(apiVersion: string): ProjectionArtifact {
  return {
    apiVersion,
    generatedAt: new Date().toISOString(),
    capabilities: FALLBACK_CAPABILITIES,
    tables: {},
    relationships: [],
    deletedVariants: [],
  }
}

function normalizeConfigForCapabilities(
  config: ProjectionConfig,
  capabilities: VersionCapabilities | null
): ProjectionConfig {
  if (!capabilities) {
    return config
  }

  const normalized: ProjectionConfig = { ...config }

  if (
    !capabilities.hasV2Namespace &&
    (normalized.namespaceMode === 'v2' || normalized.namespaceMode === 'both')
  ) {
    normalized.namespaceMode = 'v1'
  }

  if (!capabilities.hasDeletedVariants && normalized.deletedMode === 'table') {
    normalized.deletedMode = 'column'
  }

  if (!capabilities.hasListEndpointMetadata && normalized.listEndpointMode !== 'either') {
    normalized.listEndpointMode = 'either'
  }

  if (!capabilities.hasWebhookEventMetadata && normalized.webhookEventMode !== 'either') {
    normalized.webhookEventMode = 'either'
  }

  return normalized
}

function isSameConfig(left: ProjectionConfig, right: ProjectionConfig): boolean {
  return (
    left.namespaceMode === right.namespaceMode &&
    left.listEndpointMode === right.listEndpointMode &&
    left.webhookEventMode === right.webhookEventMode &&
    left.fkMode === right.fkMode &&
    left.timestampMode === right.timestampMode &&
    left.deletedMode === right.deletedMode
  )
}

/**
 * useProjection Hook
 *
 * @param options - Hook configuration options
 * @returns Projection state and controls
 */
export function useProjection(options?: UseProjectionOptions): UseProjectionResult {
  const { version = null, initialConfig } = options || {}

  // Projection config state (user-controllable)
  const [config, setConfigState] = useState<ProjectionConfig>(() => ({
    ...DEFAULT_PROJECTION_CONFIG,
    ...initialConfig,
  }))

  // Artifact loading state
  const [artifact, setArtifact] = useState<ProjectionArtifact | null>(null)
  const [loadingState, setLoadingState] = useState<'idle' | 'loading' | 'ready' | 'fallback'>(
    'idle'
  )
  const [error, setError] = useState<string | null>(null)

  // Track current fetch to cancel stale requests
  const abortControllerRef = useRef<AbortController | null>(null)

  /**
   * Fetch projection.json for the given version
   */
  const fetchProjection = useCallback(async (apiVersion: string) => {
    // Cancel any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    const abortController = new AbortController()
    abortControllerRef.current = abortController

    setLoadingState('loading')
    setError(null)
    setArtifact(null)

    try {
      const url = `/explorer-data/${apiVersion}/projection.json`
      console.log(`[useProjection] Fetching projection artifact: ${url}`)

      const response = await fetch(url, {
        signal: abortController.signal,
        cache: 'no-store',
      })

      // If request was cancelled, ignore result
      if (abortController.signal.aborted) {
        return
      }

      // Handle 404 as fallback mode (not an error)
      if (response.status === 404) {
        console.warn(
          `[useProjection] No projection.json found for version ${apiVersion}, using fallback mode`
        )
        setArtifact(createFallbackArtifact(apiVersion))
        setLoadingState('fallback')
        return
      }

      // Other HTTP errors are real errors
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = (await response.json()) as ProjectionArtifact

      // Validate basic structure
      if (!data.tables || !data.relationships || !data.capabilities) {
        throw new Error('Invalid projection artifact structure')
      }

      // If request was cancelled during JSON parsing, ignore result
      if (abortController.signal.aborted) {
        return
      }

      console.log(
        `[useProjection] Loaded projection artifact for ${apiVersion}:`,
        `${data.capabilities.tableCount} tables,`,
        `${data.capabilities.relationshipCount} relationships`
      )

      setArtifact(data)
      setLoadingState('ready')
    } catch (err) {
      // Ignore abort errors (intentional cancellations)
      if (
        abortController.signal.aborted ||
        (err instanceof Error && err.name === 'AbortError') ||
        (typeof err === 'object' &&
          err !== null &&
          'name' in err &&
          (err as { name?: string }).name === 'AbortError')
      ) {
        return
      }

      const errorMessage = err instanceof Error ? err.message : 'Unknown error loading projection'
      console.error(`[useProjection] Failed to load projection artifact:`, err)
      setError(errorMessage)
      setLoadingState('idle')
    }
  }, [])

  /**
   * Effect: Fetch projection.json when version changes
   */
  useEffect(() => {
    if (!version) {
      // No version specified - stay idle
      setLoadingState('idle')
      setArtifact(null)
      setError(null)
      return
    }

    fetchProjection(version)

    // Cleanup: abort fetch on unmount or version change
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }
    }
  }, [version, fetchProjection])

  /**
   * Extract capabilities from artifact
   */
  const capabilities = useMemo<VersionCapabilities | null>(() => {
    return artifact?.capabilities ?? null
  }, [artifact])

  /**
   * Keep config aligned with the current artifact's capabilities.
   */
  useEffect(() => {
    if (!capabilities) {
      return
    }

    setConfigState((prev) => {
      const normalized = normalizeConfigForCapabilities(prev, capabilities)
      return isSameConfig(prev, normalized) ? prev : normalized
    })
  }, [capabilities])

  const setConfig = useCallback(
    (nextConfig: ProjectionConfig | ((prev: ProjectionConfig) => ProjectionConfig)) => {
      setConfigState((prev) => {
        const candidate =
          typeof nextConfig === 'function'
            ? (nextConfig as (prev: ProjectionConfig) => ProjectionConfig)(prev)
            : nextConfig

        return normalizeConfigForCapabilities(candidate, capabilities)
      })
    },
    [capabilities]
  )

  /**
   * Derive projected model from artifact + config
   * Memoized to avoid unnecessary recalculation
   */
  const projectedModel = useMemo<ProjectedERDModel | null>(() => {
    if (!artifact) {
      return null
    }

    // Derive model using projection engine
    const model = deriveProjectedModel(artifact, config)

    console.log(
      `[useProjection] Derived model:`,
      `${model.metadata.visibleTables} visible tables,`,
      `${model.metadata.visibleRelationships} relationships,`,
      `${model.metadata.virtualTablesAdded} virtual tables added`
    )

    return model
  }, [artifact, config])

  return {
    projectedModel,
    config,
    setConfig,
    capabilities,
    loadingState,
    error,
    artifact,
  }
}
