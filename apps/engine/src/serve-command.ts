import { createConnectorResolver } from './lib/index.js'
import { createApp } from './api/app.js'
import { parseJsonOrFile } from '@stripe/sync-ts-cli'
import { defaultConnectors } from './lib/default-connectors.js'
import { startServer } from './server.js'

export async function serveAction(opts: {
  port?: number
  connectorsFromCommandMap?: string
  connectorsFromPath?: boolean
  connectorsFromNpm?: boolean
}) {
  const port = opts.port ?? Number(process.env['PORT'] || 3000)
  const resolver = await createConnectorResolver(defaultConnectors, {
    commandMap: parseJsonOrFile(opts.connectorsFromCommandMap) as
      | Record<string, string>
      | undefined,
    path: opts.connectorsFromPath,
    npm: opts.connectorsFromNpm ?? false,
  })
  const app = await createApp(resolver)
  await startServer(app, port)
}
