import sourceStripe from '@stripe/sync-source-stripe'
import sourcePostgres from '@stripe/sync-source-postgres'
import sourceMetronome from '@stripe/sync-source-metronome'
import destinationStripe from '@stripe/sync-destination-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import destinationGoogleSheets from '@stripe/sync-destination-google-sheets'
import destinationRedis from '@stripe/sync-destination-redis'
import type { RegisteredConnectors } from './resolver.js'

/** Default in-process connectors bundled with the engine. */
export const defaultConnectors: RegisteredConnectors = {
  sources: { stripe: sourceStripe, postgres: sourcePostgres, metronome: sourceMetronome },
  destinations: {
    stripe: destinationStripe,
    postgres: destinationPostgres,
    google_sheets: destinationGoogleSheets,
    redis: destinationRedis,
  },
}
