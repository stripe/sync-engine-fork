// @ts-ignore
import syncFunctionCodeRaw from './edge-functions/stripe-sync.ts?raw'

export const syncFunctionCode = syncFunctionCodeRaw as string

// Legacy exports kept for backward compatibility
export const setupFunctionCode = syncFunctionCodeRaw as string
export const webhookFunctionCode = syncFunctionCodeRaw as string
export const workerFunctionCode = syncFunctionCodeRaw as string
export const sigmaWorkerFunctionCode = syncFunctionCodeRaw as string
