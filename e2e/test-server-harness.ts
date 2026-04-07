import { execSync } from 'node:child_process'
import path from 'node:path'
import pg from 'pg'
import {
  createStripeListServer,
  ensureObjectTable,
  ensureSchema,
  startDockerPostgres18,
  type DockerPostgres18Handle,
  type StripeListServer,
} from '@stripe/sync-test-utils'

export const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:4020'
export const ENGINE_URL = process.env.ENGINE_URL ?? 'http://localhost:4010'
export const STRIPE_MOCK_URL = process.env.STRIPE_MOCK_URL ?? 'http://localhost:12111'
export const CONTAINER_HOST = process.env.CONTAINER_HOST ?? 'host.docker.internal'
export const SKIP_SETUP = process.env.SKIP_SETUP === '1'
export const REPO_ROOT = path.resolve(import.meta.dirname, '..')
export const COMPOSE_CMD = `docker compose -f compose.yml -f compose.dev.yml -f e2e/compose.e2e.yml`

export const CUSTOMER_COUNT = 10_000
export const SEED_BATCH = 1000
export const SOURCE_SCHEMA = 'stripe'

export function utc(date: string): number {
  return Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000)
}

export const RANGE_START = utc('2021-04-03')
export const RANGE_END = utc('2026-04-02')

export async function pollUntil(
  fn: () => Promise<boolean>,
  { timeout = 300_000, interval = 2000 } = {}
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`pollUntil timed out after ${timeout}ms`)
}

async function isServiceHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVICE_URL}/health`)
    return res.ok
  } catch {
    return false
  }
}

async function isEngineHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE_URL}/health`)
    return res.ok
  } catch {
    return false
  }
}

async function ensureDockerStack(): Promise<void> {
  console.log('\n  Building packages...')
  execSync('pnpm build', { cwd: REPO_ROOT, stdio: 'inherit' })
  console.log('  Starting Docker stack...')
  execSync(`${COMPOSE_CMD} up --build -d stripe-mock temporal engine service worker`, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
  console.log('  Waiting for service health...')
  await pollUntil(isServiceHealthy, { timeout: 180_000 })
}

export async function ensureStripeMock(): Promise<void> {
  execSync('docker compose up -d stripe-mock', { cwd: REPO_ROOT, stdio: 'pipe' })
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${STRIPE_MOCK_URL}/v1/customers`, {
        headers: { Authorization: 'Bearer sk_test_fake' },
      })
      if (res.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('stripe-mock did not become ready')
}

export async function ensureServiceStack(): Promise<void> {
  if (SKIP_SETUP) {
    console.log('\n  SKIP_SETUP=1 — ensuring stripe-mock is up')
    await ensureStripeMock()
  } else {
    await ensureDockerStack()
  }
  await pollUntil(isServiceHealthy, { timeout: 60_000 })
}

export async function ensureEngineStack(): Promise<void> {
  if (SKIP_SETUP) {
    console.log('\n  SKIP_SETUP=1 — ensuring stripe-mock is up')
    await ensureStripeMock()
  } else if (!(await isEngineHealthy())) {
    await ensureDockerStack()
  } else {
    await ensureStripeMock()
  }

  await pollUntil(isEngineHealthy, { timeout: 60_000 })
}

function pool(connectionString: string): pg.Pool {
  const next = new pg.Pool({ connectionString })
  next.on('error', () => {})
  return next
}

async function fetchObjectTemplate(
  endpoint: string,
  body?: string
): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_MOCK_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer sk_test_fake',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    ...(body != null ? { body } : {}),
  })
  if (!res.ok) throw new Error(`stripe-mock POST ${endpoint} failed: ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

export type ServiceHarness = {
  sourceDocker: DockerPostgres18Handle
  destDocker: DockerPostgres18Handle
  destPool: pg.Pool
  testServer: StripeListServer
  expectedIds: string[]
  testServerContainerUrl: () => string
  destPgContainerUrl: () => string
  close: () => Promise<void>
}

export async function startServiceHarness(): Promise<ServiceHarness> {
  await ensureServiceStack()

  const [sourceDocker, destDocker] = await Promise.all([startDockerPostgres18(), startDockerPostgres18()])
  const destPool = pool(destDocker.connectionString)
  const testServer = await createStripeListServer({
    postgresUrl: sourceDocker.connectionString,
    host: '0.0.0.0',
    port: 0,
    accountCreated: RANGE_START,
    seedCustomers: {
      stripeMockUrl: STRIPE_MOCK_URL,
      count: CUSTOMER_COUNT,
      batchSize: SEED_BATCH,
      createdRange: { startUnix: RANGE_START, endUnix: RANGE_END },
    },
  })
  const expectedIds = testServer.seededCustomerIds ?? []

  console.log(`  Source PG:       ${sourceDocker.connectionString}`)
  console.log(`  Dest PG:         ${destDocker.connectionString}`)
  console.log(`  Test server:     http://0.0.0.0:${testServer.port}`)
  console.log(`  Service API:     ${SERVICE_URL}`)
  console.log(`  Container host:  ${CONTAINER_HOST}`)

  return {
    sourceDocker,
    destDocker,
    destPool,
    testServer,
    expectedIds,
    testServerContainerUrl: () => `http://${CONTAINER_HOST}:${testServer.port}`,
    destPgContainerUrl: () => destDocker.connectionString.replace('localhost', CONTAINER_HOST),
    close: async () => {
      await testServer.close().catch(() => {})
      await destPool.end().catch(() => {})
      await destDocker.stop()
      await sourceDocker.stop()
    },
  }
}

export type EngineHarness = {
  sourceDocker: DockerPostgres18Handle
  destDocker: DockerPostgres18Handle
  testServer: StripeListServer
  sourcePool: pg.Pool
  destPool: pg.Pool
  customerTemplate: Record<string, unknown>
  productTemplate: Record<string, unknown>
  hostTestServerUrl: () => string
  testServerContainerUrl: () => string
  destPgContainerUrl: () => string
  close: () => Promise<void>
}

export async function startEngineHarness(): Promise<EngineHarness> {
  await ensureEngineStack()

  const [sourceDocker, destDocker, customerTemplate, productTemplate] = await Promise.all([
    startDockerPostgres18(),
    startDockerPostgres18(),
    fetchObjectTemplate('/v1/customers'),
    fetchObjectTemplate('/v1/products', 'name=Test+Product'),
  ])

  const sourcePool = pool(sourceDocker.connectionString)
  const destPool = pool(destDocker.connectionString)

  await ensureSchema(sourcePool, SOURCE_SCHEMA)
  await Promise.all([
    ensureObjectTable(sourcePool, SOURCE_SCHEMA, 'customers'),
    ensureObjectTable(sourcePool, SOURCE_SCHEMA, 'products'),
  ])

  const testServer = await createStripeListServer({
    postgresUrl: sourceDocker.connectionString,
    host: '0.0.0.0',
    port: 0,
    accountCreated: RANGE_START,
  })

  return {
    sourceDocker,
    destDocker,
    testServer,
    sourcePool,
    destPool,
    customerTemplate,
    productTemplate,
    hostTestServerUrl: () => `http://127.0.0.1:${testServer.port}`,
    testServerContainerUrl: () => `http://${CONTAINER_HOST}:${testServer.port}`,
    destPgContainerUrl: () => destDocker.connectionString.replace('localhost', CONTAINER_HOST),
    close: async () => {
      await testServer.close().catch(() => {})
      await sourcePool.end().catch(() => {})
      await destPool.end().catch(() => {})
      await destDocker.stop()
      await sourceDocker.stop()
    },
  }
}
