'use client'

import { useEffect, useState } from 'react'
import type { VersionIndex } from '@/types/version-index'

type VersionIndexStatus = 'loading' | 'ready' | 'error'

interface UseVersionIndexResult {
  versionIndex: VersionIndex | null
  status: VersionIndexStatus
  error: string | null
}

export function useVersionIndex(): UseVersionIndexResult {
  const [versionIndex, setVersionIndex] = useState<VersionIndex | null>(null)
  const [status, setStatus] = useState<VersionIndexStatus>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadVersionIndex() {
      try {
        const response = await fetch('/explorer-data/index.json', {
          cache: 'no-store',
        })
        if (!response.ok) {
          throw new Error(`Failed to load version index: ${response.status} ${response.statusText}`)
        }

        const data = (await response.json()) as VersionIndex
        if (cancelled) {
          return
        }

        setVersionIndex(data)
        setStatus('ready')
      } catch (err) {
        if (cancelled) {
          return
        }

        setError(err instanceof Error ? err.message : 'Failed to load version index')
        setStatus('error')
      }
    }

    void loadVersionIndex()

    return () => {
      cancelled = true
    }
  }, [])

  return {
    versionIndex,
    status,
    error,
  }
}
