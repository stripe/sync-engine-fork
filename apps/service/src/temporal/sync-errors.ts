export type SyncRunError = {
  message: string
  failure_type?: string
  stream?: string
}

export type ClassifiedSyncErrors = {
  transient: SyncRunError[]
  permanent: SyncRunError[]
}

export function classifySyncErrors(errors: SyncRunError[]): ClassifiedSyncErrors {
  const transient: SyncRunError[] = []
  const permanent: SyncRunError[] = []

  for (const error of errors) {
    if (error.failure_type === 'transient_error') {
      transient.push(error)
    } else {
      permanent.push(error)
    }
  }

  return { transient, permanent }
}

export function summarizeSyncErrors(errors: SyncRunError[]): string {
  return errors
    .map((error) => {
      const failureType = error.failure_type ?? 'unknown_error'
      const stream = error.stream ? `/${error.stream}` : ''
      return `[${failureType}${stream}] ${error.message}`
    })
    .join('; ')
}
