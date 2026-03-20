'use client'

import { useState, useCallback } from 'react'
import type { VersionIndex } from '@/types/version-index'

interface VersionPickerProps {
  versionIndex: VersionIndex | null
  selectedVersion?: string | null
  onVersionChange: (version: string) => void
  className?: string
}

/**
 * VersionPicker Component
 *
 * A polished dropdown for selecting API versions. Integrates with the visualizer's
 * indigo/slate theme.
 *
 * Features:
 * - Displays version labels with metadata
 * - Highlights currently selected version
 * - Calls onVersionChange callback when user selects a different version
 *
 * Usage:
 *   <VersionPicker
 *     versionIndex={versionIndex}
 *     selectedVersion={currentVersion}
 *     onVersionChange={(version) => setCurrentVersion(version)}
 *   />
 */
export default function VersionPicker({
  versionIndex,
  selectedVersion,
  onVersionChange,
  className = '',
}: VersionPickerProps) {
  const [isOpen, setIsOpen] = useState(false)

  const handleVersionSelect = useCallback(
    (version: string) => {
      if (version !== selectedVersion) {
        onVersionChange(version)
      }
      setIsOpen(false)
    },
    [selectedVersion, onVersionChange]
  )

  if (!versionIndex) {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <div className="h-9 w-40 animate-pulse rounded-lg bg-slate-100" />
      </div>
    )
  }

  // Find the currently selected version metadata
  const currentVersionData = versionIndex.versions.find((v) => v.apiVersion === selectedVersion)
  const displayLabel = currentVersionData?.label ?? selectedVersion ?? 'Select Version'

  return (
    <div className={`relative ${className}`}>
      {/* Dropdown Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-9 min-w-[160px] items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 shadow-sm transition-all duration-150 ease-out hover:-translate-y-px hover:border-indigo-300 hover:shadow-md focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
        aria-label="Select API version"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-indigo-500">
            API
          </span>
          <span className="font-mono text-slate-900">{displayLabel}</span>
        </div>
        <svg
          className={`h-4 w-4 text-slate-500 transition-transform duration-200 ${
            isOpen ? 'rotate-180' : ''
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <>
          {/* Backdrop to close dropdown */}
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />

          {/* Menu */}
          <div className="absolute right-0 z-20 mt-2 w-72 origin-top-right rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="max-h-96 overflow-y-auto p-2">
              {versionIndex.versions.map((version) => {
                const isSelected = version.apiVersion === selectedVersion
                const isDefault = version.apiVersion === versionIndex.defaultVersion

                return (
                  <button
                    key={version.apiVersion}
                    type="button"
                    onClick={() => handleVersionSelect(version.apiVersion)}
                    className={`mb-1 flex w-full cursor-pointer flex-col rounded-lg border px-3 py-2.5 text-left transition-all duration-150 ease-out hover:-translate-y-px last:mb-0 ${
                      isSelected
                        ? 'border-indigo-200 bg-indigo-50 shadow-sm'
                        : 'border-transparent bg-white hover:border-slate-200 hover:bg-slate-50 hover:shadow-sm'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`font-mono text-[13px] font-semibold ${
                          isSelected ? 'text-indigo-700' : 'text-slate-900'
                        }`}
                      >
                        {version.label}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {isDefault && (
                          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
                            Default
                          </span>
                        )}
                        {isSelected && (
                          <svg
                            className="h-4 w-4 text-indigo-600"
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path
                              fillRule="evenodd"
                              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                              clipRule="evenodd"
                            />
                          </svg>
                        )}
                      </div>
                    </div>
                    <div
                      className={`mt-1.5 flex items-center gap-3 text-[11px] ${
                        isSelected ? 'text-indigo-600' : 'text-slate-500'
                      }`}
                    >
                      <span>{version.tableCount} tables</span>
                      <span>•</span>
                      <span>{version.totalRows.toLocaleString()} rows</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
