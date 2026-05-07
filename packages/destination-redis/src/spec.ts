import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'

export const configSchema = z
  .object({
    url: z.string().optional().describe('Redis connection URL (redis://host:port)'),
    host: z.string().optional().describe('Redis host (default: localhost)'),
    port: z.number().optional().describe('Redis port (default: 6379)'),
    password: z.string().optional().describe('Redis password'),
    db: z.number().optional().describe('Redis database number (default: 0)'),
    tls: z.boolean().optional().describe('Enable TLS'),
    key_prefix: z.string().optional().describe('Prefix for all Redis keys (default: empty)'),
    batch_size: z.number().default(100).describe('Records to buffer before flushing via pipeline'),
  })
  .refine((c) => !(c.url && (c.host || c.port)), {
    message: 'Specify either url or host/port, not both',
    path: ['url'],
  })

export type Config = z.infer<typeof configSchema>

export default {
  config: z.toJSONSchema(configSchema),
} satisfies ConnectorSpecification
