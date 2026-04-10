import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'

export const configSchema = z.object({
  endpoint: z.string().describe('DSQL cluster endpoint (e.g. <id>.dsql.<region>.on.aws)'),
  region: z.string().describe('AWS region for the DSQL cluster'),
  schema: z.string().default('public').describe('Target schema name'),
  batch_size: z.number().default(100).describe('Records to buffer before flushing'),
})

export type Config = z.infer<typeof configSchema>

export default {
  config: z.toJSONSchema(configSchema),
} satisfies ConnectorSpecification
