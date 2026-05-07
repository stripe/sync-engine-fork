import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'

export const configSchema = z.object({
  api_key: z.string().describe('Metronome API bearer token'),
  base_url: z
    .string()
    .url()
    .optional()
    .describe('Override the Metronome API base URL (default: https://api.metronome.com)'),
  rate_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max requests per second (default: no limit)'),
  backfill_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max records to fetch per stream (useful for testing)'),
  webhook_secret: z
    .string()
    .optional()
    .describe('Webhook signing secret for HMAC-SHA256 signature verification'),
  webhook_port: z
    .number()
    .int()
    .optional()
    .describe('Port for built-in webhook HTTP listener (e.g. 4243)'),
})

export type Config = z.infer<typeof configSchema>

export const streamStateSpec = z.object({
  next_page: z
    .string()
    .nullable()
    .describe('Cursor token for pagination. Null means stream is complete.'),
})

export type StreamState = z.infer<typeof streamStateSpec>

export default {
  config: z.toJSONSchema(configSchema),
  source_state_stream: z.toJSONSchema(streamStateSpec),
} satisfies ConnectorSpecification
