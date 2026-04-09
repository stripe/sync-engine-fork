import 'dotenv/config'
import { Readable } from 'node:stream'
import { defineCommand } from 'citty'
import { createCliFromSpec } from '@stripe/sync-ts-cli/openapi'
import { parseJsonOrFile } from '@stripe/sync-ts-cli'
import {
  createConnectorResolver,
  createEngine,
  selectStateStore,
  pipe,
  persistState,
} from '../lib/index.js'
import { collectMessages, PipelineConfig, writeLine } from '@stripe/sync-protocol'
import { createApp } from '../api/app.js'
import { serveAction } from '../serve-command.js'
import { supabaseCmd } from './supabase.js'
import { defaultConnectors } from '../lib/default-connectors.js'
import { logger } from '../logger.js'
import { resolveAccountId, type Config as StripeSourceConfig } from '@stripe/sync-source-stripe'

/** Connector discovery flags shared by all commands (serve + one-shot). */
const connectorArgs = {
  connectorsFromCommandMap: {
    type: 'string' as const,
    description: 'Explicit connector command mappings (JSON object or @file)',
  },
  noConnectorsFromPath: {
    type: 'boolean' as const,
    default: false,
    description: 'Disable PATH-based connector discovery',
  },
  connectorsFromNpm: {
    type: 'boolean' as const,
    default: false,
    description: 'Enable npm auto-download of connectors (disabled by default)',
  },
}

// Hand-written workflow command: start HTTP server
const serveCmd = defineCommand({
  meta: { name: 'serve', description: 'Start the HTTP API server' },
  args: {
    port: { type: 'string', description: 'Port to listen on (or PORT env)' },
    ...connectorArgs,
  },
  async run({ args }) {
    await serveAction({
      port: args.port ? parseInt(args.port) : undefined,
      connectorsFromCommandMap: args.connectorsFromCommandMap,
      connectorsFromPath: !args.noConnectorsFromPath,
      connectorsFromNpm: args.connectorsFromNpm,
    })
  },
})

/**
 * Pre-parse connector discovery flags from process.argv so the resolver
 * is configured before the one-shot CLI commands (check, read, etc.) run.
 */
function parseConnectorFlags(): {
  connectorsFromPath: boolean
  connectorsFromNpm: boolean
  connectorsFromCommandMap?: string
} {
  const argv = process.argv
  const noPath = argv.includes('--no-connectors-from-path')
  const npm = argv.includes('--connectors-from-npm')
  let commandMap: string | undefined
  const cmdMapIdx = argv.indexOf('--connectors-from-command-map')
  if (cmdMapIdx !== -1 && cmdMapIdx + 1 < argv.length) {
    commandMap = argv[cmdMapIdx + 1]
  }
  return {
    connectorsFromPath: !noPath,
    connectorsFromNpm: npm,
    connectorsFromCommandMap: commandMap,
  }
}

export async function createProgram() {
  const flags = parseConnectorFlags()
  const resolver = await createConnectorResolver(defaultConnectors, {
    path: flags.connectorsFromPath,
    npm: flags.connectorsFromNpm,
    commandMap: parseJsonOrFile(flags.connectorsFromCommandMap) as
      | Record<string, string>
      | undefined,
  })
  const app = await createApp(resolver)
  const res = await app.request('/openapi.json')
  const spec = await res.json()

  const specCli = createCliFromSpec({
    spec,
    handler: async (req) => app.fetch(req),
    exclude: ['health'],
    ndjsonBodyStream: () =>
      process.stdin.isTTY ? null : (Readable.toWeb(process.stdin) as ReadableStream),
    rootArgs: connectorArgs,
    meta: {
      name: 'sync-engine',
      description: 'Stripe Sync Engine — sync Stripe data to Postgres',
      version: '0.1.0',
    },
  })

  const syncMultiCmd = defineCommand({
    meta: {
      name: 'sync-multi',
      description:
        'Sync multiple Stripe accounts into a shared schema. Accepts a JSON config with a "pipelines" array of PipelineConfig objects.',
    },
    args: {
      config: {
        type: 'string',
        description: 'JSON file path or inline JSON: { "pipelines": [PipelineConfig, ...] }',
        required: true,
      },
    },
    async run({ args }) {
      const raw = parseJsonOrFile(args.config)
      const pipelinesRaw = (raw as { pipelines?: unknown[] }).pipelines
      if (!Array.isArray(pipelinesRaw) || pipelinesRaw.length === 0) {
        logger.error('Config must contain a non-empty "pipelines" array')
        process.exit(1)
      }

      const pipelines = pipelinesRaw.map((p, i) => {
        try {
          return PipelineConfig.parse(p)
        } catch (err) {
          logger.error({ err, index: i }, `Invalid pipeline config at index ${i}`)
          process.exit(1)
        }
      })

      const engine = await createEngine(resolver)
      const runs: Array<{
        pipeline: PipelineConfig
        stateStore: Awaited<ReturnType<typeof selectStateStore>>
        index: number
      }> = []

      // Setup sequentially to avoid racing on CREATE SCHEMA
      for (let i = 0; i < pipelines.length; i++) {
        let pipeline = pipelines[i]
        const { messages: controlMessages } = await collectMessages(
          engine.pipeline_setup(pipeline),
          'control'
        )
        for (const message of controlMessages) {
          if (message.control.control_type === 'source_config') {
            const type = pipeline.source.type
            pipeline = {
              ...pipeline,
              source: { type, [type]: message.control.source_config } as PipelineConfig['source'],
            }
          } else if (message.control.control_type === 'destination_config') {
            const type = pipeline.destination.type
            pipeline = {
              ...pipeline,
              destination: {
                type,
                [type]: message.control.destination_config,
              } as PipelineConfig['destination'],
            }
          }
        }
        const accountId = await resolveAccountId(pipeline.source as unknown as StripeSourceConfig)
        const stateStore = await selectStateStore(pipeline, accountId)
        logger.info({ pipeline: i }, 'sync-multi: setup completed')
        runs.push({ pipeline, stateStore, index: i })
      }

      // Read/write concurrently — setup is already done
      await Promise.all(
        runs.map(async ({ pipeline, stateStore, index: i }) => {
          logger.info({ pipeline: i }, 'sync-multi: starting sync')
          try {
            const state = await stateStore.get()
            for await (const msg of pipe(
              engine.pipeline_write(pipeline, engine.pipeline_read(pipeline, { state })),
              persistState(stateStore)
            )) {
              writeLine(msg)
            }
            logger.info({ pipeline: i }, 'sync-multi: pipeline completed')
          } finally {
            await stateStore.close?.()
          }
        })
      )
    },
  })

  return defineCommand({
    ...specCli,
    subCommands: {
      serve: serveCmd,
      supabase: supabaseCmd,
      'sync-multi': syncMultiCmd,
      ...specCli.subCommands,
    },
  })
}
