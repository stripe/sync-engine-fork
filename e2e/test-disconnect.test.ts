/**
 * Black-box disconnect + time-limit tests.
 *
 * Architecture:
 *   Test process  ----(HTTP)---->  Engine server (black box)  ----(HTTP)---->  Mock Stripe API
 *
 * The engine is started as a separate process (Node, Bun, or Docker).
 * The mock Stripe API is a lightweight Hono server started by the test.
 * Assertions use three signals:
 *   1. Mock server request count (proves engine stopped making API calls)
 *   2. Engine stderr log lines (distinct tags per termination type)
 *   3. NDJSON eof payload (elapsed_ms, cutoff)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { BUNDLED_API_VERSION } from '@stripe/sync-openapi'

// ── Constants ──────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const ENGINE_DIST = path.join(REPO_ROOT, 'apps/engine/dist/api/index.js')
const ENGINE_SRC = path.join(REPO_ROOT, 'apps/engine/src/api/index.ts')

function hasBun(): boolean {
  try {
    execSync('bun --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function hasDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ── Mock Stripe API ────────────────────────────────────────────

interface MockStripeServer {
  url: string
  requestCount: () => number
  resetCount: () => void
  close: () => Promise<void>
}

async function startMockStripeApi(opts: { delayMs?: number } = {}): Promise<MockStripeServer> {
  const delayMs = opts.delayMs ?? 0
  let count = 0

  const app = new Hono()

  app.get('/request_count', (c) => c.json({ count }))

  // GET /v1/account
  app.get('/v1/account', (c) =>
    c.json({
      id: 'acct_test_mock',
      object: 'account',
      type: 'standard',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      country: 'US',
      default_currency: 'usd',
      created: 1000000000,
      settings: { dashboard: { display_name: 'Mock' } },
    })
  )

  // GET /v1/customers — paginated list with configurable delay
  app.get('/v1/customers', async (c) => {
    count++
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    const startingAfter = c.req.query('starting_after')
    const pageIndex = startingAfter ? parseInt(startingAfter.replace('cus_', '')) : 0
    const pageSize = 10
    const data = Array.from({ length: pageSize }, (_, i) => ({
      id: `cus_${pageIndex + i + 1}`,
      object: 'customer',
      name: `Customer ${pageIndex + i + 1}`,
      email: `c${pageIndex + i + 1}@test.com`,
      created: 1000000000 + pageIndex + i + 1,
    }))
    return c.json({
      object: 'list',
      url: '/v1/customers',
      has_more: true,
      data,
    })
  })

  // Catch-all for discover/spec calls
  app.all('/v1/:resource', (c) => {
    count++
    return c.json({ object: 'list', url: `/v1/${c.req.param('resource')}`, has_more: false, data: [] })
  })

  const serverRef = { value: null as ReturnType<typeof serve> | null }
  const url = await new Promise<string>((resolve) => {
    serverRef.value = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve(`http://localhost:${(info as AddressInfo).port}`)
    })
  })

  return {
    url,
    requestCount: () => count,
    resetCount: () => {
      count = 0
    },
    close: () =>
      new Promise((resolve, reject) => {
        serverRef.value?.close((err: Error | null) => (err ? reject(err) : resolve()))
      }),
  }
}

// ── Engine process management ──────────────────────────────────

interface EngineProcess {
  url: string
  stderr: string
  kill: () => void
}

function getPort(): number {
  return 10_000 + Math.floor(Math.random() * 50_000)
}

async function startEngineNode(port: number): Promise<EngineProcess> {
  let stderr = ''
  let exited = false
  const child = spawn('node', [ENGINE_DIST], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'trace', LOG_PRETTY: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.on('exit', (code) => {
    exited = true
    if (code !== 0 && code !== null) {
      console.error(`Engine process exited with code ${code}. stderr:\n${stderr}`)
    }
  })

  await waitForServer(`http://localhost:${port}`, 60_000, () => {
    if (exited) throw new Error(`Engine exited before becoming healthy. stderr:\n${stderr}`)
  })
  return {
    url: `http://localhost:${port}`,
    get stderr() {
      return stderr
    },
    kill: () => child.kill(),
  }
}

async function startEngineBun(port: number): Promise<EngineProcess> {
  let stderr = ''
  let exited = false
  const child = spawn('bun', [ENGINE_SRC], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'trace', LOG_PRETTY: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.on('exit', (code) => {
    exited = true
    if (code !== 0 && code !== null) {
      console.error(`Bun engine process exited with code ${code}. stderr:\n${stderr}`)
    }
  })

  await waitForServer(`http://localhost:${port}`, 60_000, () => {
    if (exited) throw new Error(`Bun engine exited before becoming healthy. stderr:\n${stderr}`)
  })
  return {
    url: `http://localhost:${port}`,
    get stderr() {
      return stderr
    },
    kill: () => child.kill(),
  }
}

async function startEngineDocker(port: number, mockUrl: string): Promise<EngineProcess> {
  const image = 'sync-engine:disconnect-test'
  // Build the image
  execSync(`docker build -t ${image} .`, { cwd: REPO_ROOT, stdio: 'ignore' })

  const containerName = `disconnect-test-${port}`
  execSync(
    `docker run -d --name ${containerName} -p ${port}:3000 ` +
      `--add-host=host.docker.internal:host-gateway ` +
      `${image}`,
    { cwd: REPO_ROOT, stdio: 'ignore' }
  )

  await waitForServer(`http://localhost:${port}`)

  return {
    url: `http://localhost:${port}`,
    get stderr() {
      try {
        return execSync(`docker logs ${containerName} 2>&1`, { encoding: 'utf8' })
      } catch {
        return ''
      }
    },
    kill: () => {
      try {
        execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' })
      } catch {}
    },
  }
}

async function waitForServer(
  url: string,
  timeout = 30_000,
  checkAlive?: () => void
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    checkAlive?.()
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Server at ${url} did not become healthy in ${timeout}ms`)
}

// ── NDJSON helpers ─────────────────────────────────────────────

function makePipelineHeader(mockStripeUrl: string): string {
  return JSON.stringify({
    source: {
      type: 'stripe',
      stripe: {
        api_key: 'sk_test_fake',
        api_version: BUNDLED_API_VERSION,
        base_url: mockStripeUrl,
        rate_limit: 1000,
      },
    },
    destination: {
      type: 'postgres',
      postgres: { connection_string: 'postgres://user:pass@localhost:65432/testdb' },
    },
    streams: [{ name: 'customers' }],
  })
}

async function readNdjsonLines(
  response: Response,
  maxLines = 5
): Promise<Record<string, unknown>[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const lines: Record<string, unknown>[] = []

  while (lines.length < maxLines) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop()!
    for (const part of parts) {
      if (part.trim()) {
        lines.push(JSON.parse(part))
        if (lines.length >= maxLines) break
      }
    }
  }

  reader.releaseLock()
  return lines
}

// ── Tests ──────────────────────────────────────────────────────

type RuntimeConfig = {
  name: string
  start: (port: number, mockUrl: string) => Promise<EngineProcess>
  skip: boolean
}

const runtimes: RuntimeConfig[] = [
  { name: 'node', start: (port) => startEngineNode(port), skip: false },
  { name: 'bun', start: (port) => startEngineBun(port), skip: !hasBun() },
  {
    name: 'docker',
    start: (port, mockUrl) => startEngineDocker(port, mockUrl),
    skip: !hasDocker(),
  },
]

for (const runtime of runtimes) {
  describe.skipIf(runtime.skip)(`disconnect [${runtime.name}]`, () => {
    let mockApi: MockStripeServer
    let engine: EngineProcess

    beforeAll(async () => {
      mockApi = await startMockStripeApi({ delayMs: 200 })
      const port = getPort()
      engine = await runtime.start(port, mockApi.url)
    }, 120_000)

    afterAll(async () => {
      engine?.kill()
      await mockApi?.close()
    })

    beforeEach(() => {
      mockApi.resetCount()
    })

    it('client disconnect stops the engine from making further API calls', async () => {
      const pipelineHeader = makePipelineHeader(mockApi.url)
      const ac = new AbortController()

      // Start a streaming sync request
      const fetchPromise = fetch(`${engine.url}/pipeline_read`, {
        method: 'POST',
        headers: { 'X-Pipeline': pipelineHeader },
        signal: ac.signal,
      }).then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          console.error(`pipeline_read returned ${res.status}: ${body}`)
        }
        return res
      }).catch(() => null)

      // Wait for some requests to hit the mock
      await new Promise((r) => setTimeout(r, 1500))
      const countBeforeDisconnect = mockApi.requestCount()
      expect(countBeforeDisconnect).toBeGreaterThan(0)

      // Disconnect
      ac.abort()
      await fetchPromise

      // Wait and check that request count stopped growing
      await new Promise((r) => setTimeout(r, 2000))
      const countAfterWait = mockApi.requestCount()

      // Allow at most 2 extra requests (in-flight when abort fired)
      expect(countAfterWait - countBeforeDisconnect).toBeLessThanOrEqual(2)

      // Check for disconnect log
      expect(engine.stderr).toContain('SYNC_CLIENT_DISCONNECT')
    }, 30_000)

    it('soft time limit returns eof with cutoff=soft and elapsed_ms', async () => {
      const pipelineHeader = makePipelineHeader(mockApi.url)

      const start = Date.now()
      const res = await fetch(`${engine.url}/pipeline_read?time_limit=3`, {
        method: 'POST',
        headers: { 'X-Pipeline': pipelineHeader },
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.error(`soft time limit test: pipeline_read returned ${res.status}: ${body}`)
      }
      expect(res.status).toBe(200)

      // Read all NDJSON lines until stream ends
      const text = await res.text()
      const elapsed = Date.now() - start
      const lines = text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
      const eof = lines.find((l: any) => l.type === 'eof') as any

      expect(eof).toBeDefined()
      expect(eof.eof.reason).toBe('time_limit')
      expect(eof.eof.cutoff).toBe('soft')
      expect(typeof eof.eof.elapsed_ms).toBe('number')
      expect(eof.eof.elapsed_ms).toBeGreaterThan(1500)
      expect(eof.eof.elapsed_ms).toBeLessThan(5000)
      expect(elapsed).toBeGreaterThan(1500)
      expect(elapsed).toBeLessThan(5000)

      expect(engine.stderr).toContain('SYNC_TIME_LIMIT_SOFT')
    }, 30_000)

    it('hard time limit forces return when source blocks', async () => {
      // Use a mock with very long delay (5s per page) so the source blocks past the hard deadline
      const slowMock = await startMockStripeApi({ delayMs: 5000 })
      try {
        const pipelineHeader = makePipelineHeader(slowMock.url)

        const start = Date.now()
        const res = await fetch(`${engine.url}/pipeline_read?time_limit=2`, {
          method: 'POST',
          headers: { 'X-Pipeline': pipelineHeader },
        })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          console.error(`hard time limit test: pipeline_read returned ${res.status}: ${body}`)
        }
        expect(res.status).toBe(200)

        const text = await res.text()
        const elapsed = Date.now() - start
        const lines = text
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l))
        const eof = lines.find((l: any) => l.type === 'eof') as any

        expect(eof).toBeDefined()
        expect(eof.eof.reason).toBe('time_limit')
        expect(eof.eof.cutoff).toBe('hard')
        expect(typeof eof.eof.elapsed_ms).toBe('number')
        // Hard deadline = 2s + 1s = 3s. Allow up to 5s for CI slack.
        expect(elapsed).toBeGreaterThan(2000)
        expect(elapsed).toBeLessThan(8000)

        // Should NOT have taken 5s+ (the full page delay)
        expect(slowMock.requestCount()).toBeLessThanOrEqual(3)

        expect(engine.stderr).toContain('SYNC_TIME_LIMIT_HARD')
      } finally {
        await slowMock.close()
      }
    }, 30_000)
  })
}
