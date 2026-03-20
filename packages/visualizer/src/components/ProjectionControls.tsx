'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import type {
  ProjectionConfig,
  ProjectionArtifact,
  NamespaceMode,
  ListEndpointMode,
  WebhookEventMode,
  ForeignKeyMode,
  TimestampMode,
  DeletedMode,
} from '@/types/projection'

interface ProjectionControlsProps {
  /**
   * Current projection configuration state
   */
  config: ProjectionConfig

  /**
   * Callback invoked when user changes any projection setting
   */
  onChange: (config: ProjectionConfig) => void

  /**
   * Projection artifact containing capability flags
   * Used to disable unavailable options (e.g. v2 when hasV2Namespace is false)
   */
  artifact: ProjectionArtifact | null

  /**
   * Optional CSS class for positioning
   */
  className?: string
}

/**
 * ProjectionControls Component
 *
 * A floating control panel for ERD projection modes. Renders as a compact pill
 * in the bottom-right corner that expands into a control card with the trimmed
 * control surface:
 * - Namespace (v1 / v2 / v1 + v2)
 * - Has List Endpoint (either / yes / no)
 * - Has Webhook Event (either / yes / no)
 * - Relationship edges (show / hide)
 * - Timestamp mode (original / always timestamptz)
 * - Deleted mode (column / separate table)
 *
 * Features:
 * - Collapsed pill shows current config summary
 * - Expands on click to show full control panel
 * - Click outside or Escape key collapses the panel
 * - Options disabled when capabilities don't support them (with tooltip)
 * - Fixed positioning ensures visibility during canvas pan/zoom
 * - Consistent indigo/slate design system
 */
export default function ProjectionControls({
  config,
  onChange,
  artifact,
  className = '',
}: ProjectionControlsProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const controlsRef = useRef<HTMLDivElement>(null)
  const effectiveListEndpointMode = artifact?.capabilities.hasListEndpointMetadata
    ? config.listEndpointMode
    : 'either'
  const effectiveWebhookEventMode = artifact?.capabilities.hasWebhookEventMetadata
    ? config.webhookEventMode
    : 'either'
  const namespaceSummary = (() => {
    switch (config.namespaceMode) {
      case 'both':
        return 'v1 + v2'
      case 'v1':
        return 'v1'
      case 'v2':
        return 'v2'
    }
  })()
  const listSummary = `list:${effectiveListEndpointMode}`
  const webhookSummary = `event:${effectiveWebhookEventMode}`
  const fkSummary = config.fkMode === 'yes' ? 'fk:visible' : 'fk:hidden'
  const timestampSummary = config.timestampMode === 'raw' ? 'ts:original' : 'ts:timestamptz'
  const deletedSummary = config.deletedMode === 'column' ? 'deleted:column' : 'deleted:table'

  /**
   * Generate summary label for collapsed pill
   */
  const summaryLabel = [
    namespaceSummary,
    listSummary,
    webhookSummary,
    fkSummary,
    timestampSummary,
    deletedSummary,
  ].join(' · ')

  /**
   * Handle clicks outside the controls to collapse
   */
  useEffect(() => {
    if (!isExpanded) return

    function handleClickOutside(event: MouseEvent) {
      if (controlsRef.current && !controlsRef.current.contains(event.target as Node)) {
        setIsExpanded(false)
      }
    }

    // Delay adding listener to avoid closing immediately on the same click that opened
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timeoutId)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isExpanded])

  /**
   * Handle Escape key to collapse
   */
  useEffect(() => {
    if (!isExpanded) return

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsExpanded(false)
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isExpanded])

  /**
   * Toggle expanded state
   */
  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev)
  }, [])

  /**
   * Handle option changes
   */
  const handleNamespaceChange = useCallback(
    (mode: NamespaceMode) => {
      onChange({ ...config, namespaceMode: mode })
    },
    [config, onChange]
  )

  const handleListEndpointModeChange = useCallback(
    (mode: ListEndpointMode) => {
      onChange({ ...config, listEndpointMode: mode })
    },
    [config, onChange]
  )

  const handleWebhookEventModeChange = useCallback(
    (mode: WebhookEventMode) => {
      onChange({ ...config, webhookEventMode: mode })
    },
    [config, onChange]
  )

  const handleFkModeChange = useCallback(
    (mode: ForeignKeyMode) => {
      onChange({ ...config, fkMode: mode })
    },
    [config, onChange]
  )

  const handleTimestampModeChange = useCallback(
    (mode: TimestampMode) => {
      onChange({ ...config, timestampMode: mode })
    },
    [config, onChange]
  )

  const handleDeletedModeChange = useCallback(
    (mode: DeletedMode) => {
      onChange({ ...config, deletedMode: mode })
    },
    [config, onChange]
  )

  /**
   * Check capabilities to determine disabled options
   */
  const capabilities = artifact?.capabilities
  const canUseV2 = capabilities?.hasV2Namespace ?? false
  const canUseDeletedVariants = capabilities?.hasDeletedVariants ?? false
  const canFilterListEndpoint = capabilities?.hasListEndpointMetadata ?? false
  const canFilterWebhookEvent = capabilities?.hasWebhookEventMetadata ?? false
  const canUseTimestampTz = true

  return (
    <div
      ref={controlsRef}
      className={`fixed bottom-6 right-6 z-50 ${className}`}
      role="region"
      aria-label="Projection controls"
    >
      {/* Collapsed Pill Button */}
      {!isExpanded && (
        <button
          type="button"
          onClick={toggleExpanded}
          className="flex items-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2.5 text-[12px] font-medium text-slate-700 shadow-lg transition-all duration-150 ease-out hover:-translate-y-px hover:border-indigo-300 hover:shadow-xl focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          aria-label="Open projection controls"
          aria-expanded={false}
        >
          <svg
            className="h-4 w-4 text-indigo-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
            />
          </svg>
          <span className="font-mono">{summaryLabel}</span>
          <svg
            className="h-3.5 w-3.5 text-slate-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}

      {/* Expanded Control Card */}
      {isExpanded && (
        <div className="flex max-h-[calc(100vh-3rem)] min-w-[320px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <svg
                className="h-4 w-4 text-indigo-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
                />
              </svg>
              <h3 className="text-[13px] font-semibold text-slate-900">Projection Controls</h3>
            </div>
            <button
              type="button"
              onClick={toggleExpanded}
              className="text-slate-400 transition-colors hover:text-slate-600"
              aria-label="Close projection controls"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Control Groups */}
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {/* Namespace Mode */}
            <OptionGroup
              label="Namespace"
              options={[
                { value: 'v1', label: 'V1', disabled: false },
                {
                  value: 'v2',
                  label: 'V2',
                  disabled: !canUseV2,
                  disabledReason: 'No V2 tables in this version',
                },
                {
                  value: 'both',
                  label: 'V1 + V2',
                  disabled: !canUseV2,
                  disabledReason: 'No V2 tables in this version',
                },
              ]}
              value={config.namespaceMode}
              onChange={handleNamespaceChange}
            />
            <p className="px-1 text-[10px] leading-4 text-slate-500">
              Namespace filters use Stripe endpoint provenance ({'`/v1/*`'} vs {'`/v2/*`'}), not the
              selected API version date.
            </p>

            <OptionGroup
              label="Has List Endpoint"
              options={[
                {
                  value: 'either',
                  label: 'Either',
                  disabled: false,
                },
                {
                  value: 'yes',
                  label: 'Yes',
                  disabled: !canFilterListEndpoint,
                  disabledReason: 'No x-stripeOperations metadata in this version',
                },
                {
                  value: 'no',
                  label: 'No',
                  disabled: !canFilterListEndpoint,
                  disabledReason: 'No x-stripeOperations metadata in this version',
                },
              ]}
              value={effectiveListEndpointMode}
              onChange={handleListEndpointModeChange}
              deselectValue="either"
            />
            <p className="px-1 text-[10px] leading-4 text-slate-500">
              Uses the OpenAPI support heuristic: exactly one canonical {'`/v1/*`'} or {'`/v2/*`'}
              list path.
            </p>

            <OptionGroup
              label="Has Webhook Event"
              options={[
                {
                  value: 'either',
                  label: 'Either',
                  disabled: false,
                },
                {
                  value: 'yes',
                  label: 'Yes',
                  disabled: !canFilterWebhookEvent,
                  disabledReason: 'No x-stripeEvent metadata in this version',
                },
                {
                  value: 'no',
                  label: 'No',
                  disabled: !canFilterWebhookEvent,
                  disabledReason: 'No x-stripeEvent metadata in this version',
                },
              ]}
              value={effectiveWebhookEventMode}
              onChange={handleWebhookEventModeChange}
              deselectValue="either"
            />
            <p className="px-1 text-[10px] leading-4 text-slate-500">
              Matches resources targeted by at least one mapped {'`x-stripeEvent`'} type.
            </p>

            {/* Relationship edge visibility */}
            <OptionGroup
              label="Relationship Edges"
              options={[
                { value: 'yes', label: 'Show in ERD', disabled: false },
                { value: 'no', label: 'Hide in ERD', disabled: false },
              ]}
              value={config.fkMode}
              onChange={handleFkModeChange}
            />
            <p className="px-1 text-[10px] leading-4 text-slate-500">
              This only toggles projected relationship edges in the diagram. It does not apply
              PostgreSQL foreign key constraints, and low-confidence inferred edges stay hidden.
            </p>

            {/* Timestamp Mode */}
            <OptionGroup
              label="Timestamps"
              options={[
                { value: 'raw', label: 'Original Type', disabled: false },
                {
                  value: 'timestamptz',
                  label: 'Always Timestamptz',
                  disabled: !canUseTimestampTz,
                },
              ]}
              value={config.timestampMode}
              onChange={handleTimestampModeChange}
            />

            {/* Deleted Mode */}
            <OptionGroup
              label="Deleted Resources"
              options={[
                {
                  value: 'table',
                  label: 'Separate Table',
                  disabled: !canUseDeletedVariants,
                  disabledReason: 'No deleted variants in this version',
                },
                { value: 'column', label: 'Column on Resource', disabled: false },
              ]}
              value={config.deletedMode}
              onChange={handleDeletedModeChange}
            />
          </div>

          {/* Footer hint */}
          <div className="space-y-1.5 border-t border-slate-100 bg-slate-50 px-4 py-2.5 text-[10px] text-slate-500">
            <div className="flex items-center gap-1.5">
              <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                  clipRule="evenodd"
                />
              </svg>
              <span>Press Esc or click outside to close</span>
            </div>
            <div className="px-0.5 leading-4 text-slate-500">
              Projection controls only reshape the ERD model. They do not rewrite the hydrated
              PGlite schema.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Reusable option group component for radio-style toggles
 */
interface OptionGroupProps<T extends string> {
  label: string
  options: Array<{
    value: T
    label: string
    disabled: boolean
    disabledReason?: string
  }>
  value: T
  onChange: (value: T) => void
  deselectValue?: T
}

function OptionGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  deselectValue,
}: OptionGroupProps<T>) {
  return (
    <div>
      <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-slate-600">
        {label}
      </label>
      <div className="space-y-1.5">
        {options.map((option) => {
          const isActive = option.value === value
          const isDisabled = option.disabled

          return (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                if (isDisabled) {
                  return
                }

                if (isActive && deselectValue !== undefined && option.value !== deselectValue) {
                  onChange(deselectValue)
                  return
                }

                onChange(option.value)
              }}
              disabled={isDisabled}
              className={`group relative flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[12px] font-medium transition-all duration-100 ${
                isDisabled
                  ? 'cursor-not-allowed border-slate-100 bg-slate-50 text-slate-400'
                  : isActive
                    ? 'border-indigo-200 bg-indigo-50 text-indigo-700 shadow-sm'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-indigo-200 hover:bg-indigo-50/50 hover:text-indigo-600'
              }`}
              title={isDisabled ? option.disabledReason : undefined}
              aria-label={`${label}: ${option.label}`}
              aria-pressed={isActive}
            >
              {/* Radio indicator */}
              <div
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                  isDisabled
                    ? 'border-slate-300 bg-slate-100'
                    : isActive
                      ? 'border-indigo-600 bg-indigo-600'
                      : 'border-slate-400 bg-white group-hover:border-indigo-400'
                }`}
              >
                {isActive && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
              </div>

              {/* Label */}
              <span className="flex-1">{option.label}</span>

              {/* Disabled indicator */}
              {isDisabled && (
                <svg
                  className="h-3.5 w-3.5 shrink-0 text-slate-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                  />
                </svg>
              )}

              {/* Tooltip for disabled state */}
              {isDisabled && option.disabledReason && (
                <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[10px] text-white opacity-0 shadow-lg transition-opacity group-hover:block group-hover:opacity-100">
                  {option.disabledReason}
                  <div className="absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 border-4 border-transparent border-t-slate-900" />
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
