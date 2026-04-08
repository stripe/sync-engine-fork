import { createLogger } from '@stripe/sync-logger'

export const logger = createLogger({ name: 'engine', pretty: !!process.env.LOG_PRETTY })
