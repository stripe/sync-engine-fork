import sourceStripe from '@stripe/sync-source-stripe'
import destinationAwsDsql from '@stripe/sync-destination-aws-dsql'
import destinationPostgres from '@stripe/sync-destination-postgres'
import destinationGoogleSheets from '@stripe/sync-destination-google-sheets'
import type { RegisteredConnectors } from './resolver.js'

/** Default in-process connectors bundled with the engine. */
export const defaultConnectors: RegisteredConnectors = {
  sources: { stripe: sourceStripe },
  destinations: {
    aws_dsql: destinationAwsDsql,
    postgres: destinationPostgres,
    google_sheets: destinationGoogleSheets,
  },
}
