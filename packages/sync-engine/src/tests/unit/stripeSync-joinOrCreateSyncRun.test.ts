import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PostgresClient } from '../../database/postgres'
import { getTableName } from '../../resourceRegistry'
import type { ResourceConfig } from '../../types'

/**
 * Unit tests for PostgresClient.joinOrCreateSyncRun().
 *
 * joinOrCreateSyncRun() creates a sync run to make enqueued work visible
 * (status='pending') before processing begins, or joins an existing run.
 * This is used by workers and background processes that should cooperate.
 */
describe('joinOrCreateSyncRun', () => {
  let postgresClient: PostgresClient
  let mockGetOrCreateSyncRun: ReturnType<typeof vi.fn>
  let mockCreateObjectRuns: ReturnType<typeof vi.fn>

  const accountId = 'acct_123'
  const resourceNames = ['customers', 'products', 'prices']

  beforeEach(() => {
    postgresClient = new PostgresClient({
      schema: 'stripe',
      poolConfig: {},
    })

    mockGetOrCreateSyncRun = vi.fn()
    mockCreateObjectRuns = vi.fn().mockResolvedValue(undefined)

    postgresClient.getOrCreateSyncRun = mockGetOrCreateSyncRun
    postgresClient.createObjectRuns = mockCreateObjectRuns
  })

  it('should create sync run and return run key', async () => {
    const mockRun = {
      accountId: 'acct_123',
      runStartedAt: new Date('2024-01-01T00:00:00Z'),
      isNew: true,
    }
    mockGetOrCreateSyncRun.mockResolvedValue(mockRun)

    const result = await postgresClient.joinOrCreateSyncRun(accountId, 'test', resourceNames)

    expect(mockGetOrCreateSyncRun).toHaveBeenCalledWith('acct_123', 'test')
    expect(result).toEqual({
      accountId: mockRun.accountId,
      runStartedAt: mockRun.runStartedAt,
    })
  })

  it('should join existing run when one already exists', async () => {
    const existingRun = {
      accountId: 'acct_123',
      runStartedAt: new Date('2024-01-01T00:00:00Z'),
      isNew: false,
    }
    mockGetOrCreateSyncRun.mockResolvedValue(existingRun)

    const result = await postgresClient.joinOrCreateSyncRun(accountId, 'test', resourceNames)

    expect(mockGetOrCreateSyncRun).toHaveBeenCalledWith('acct_123', 'test')
    expect(result.accountId).toBe('acct_123')
  })

  it('should call createObjectRuns with provided resource names', async () => {
    const mockRun = {
      accountId: 'acct_123',
      runStartedAt: new Date('2024-01-01T00:00:00Z'),
      isNew: true,
    }
    mockGetOrCreateSyncRun.mockResolvedValue(mockRun)

    await postgresClient.joinOrCreateSyncRun(accountId, 'test', resourceNames)

    expect(mockCreateObjectRuns).toHaveBeenCalledTimes(1)
    expect(mockCreateObjectRuns).toHaveBeenCalledWith(
      'acct_123',
      mockRun.runStartedAt,
      ['customers', 'products', 'prices'],
      undefined
    )
  })

  it('should call createObjectRuns for existing run too', async () => {
    const existingRun = {
      accountId: 'acct_123',
      runStartedAt: new Date('2024-01-01T00:00:00Z'),
      isNew: false,
    }
    mockGetOrCreateSyncRun.mockResolvedValue(existingRun)

    await postgresClient.joinOrCreateSyncRun(accountId, 'test', resourceNames)

    expect(mockCreateObjectRuns).toHaveBeenCalledTimes(1)
    expect(mockCreateObjectRuns).toHaveBeenCalledWith(
      'acct_123',
      existingRun.runStartedAt,
      resourceNames,
      undefined
    )
  })

  describe('Resource Name Mapping Contract', () => {
    it('getTableName should produce plural resource names from object types', () => {
      const mockRegistry: Record<string, ResourceConfig> = {
        customer: { tableName: 'customers' } as ResourceConfig,
        product: { tableName: 'products' } as ResourceConfig,
        price: { tableName: 'prices' } as ResourceConfig,
        invoice: { tableName: 'invoices' } as ResourceConfig,
        subscription_schedules: { tableName: 'subscription_schedules' } as ResourceConfig,
        checkout_sessions: { tableName: 'checkout_sessions' } as ResourceConfig,
      }

      // This test documents the contract that callers must map object types
      // to resource names before calling joinOrCreateSyncRun
      expect(getTableName('customer', mockRegistry)).toBe('customers')
      expect(getTableName('product', mockRegistry)).toBe('products')
      expect(getTableName('price', mockRegistry)).toBe('prices')
      expect(getTableName('invoice', mockRegistry)).toBe('invoices')

      // Already plural types pass through
      expect(getTableName('subscription_schedules', mockRegistry)).toBe('subscription_schedules')
      expect(getTableName('checkout_sessions', mockRegistry)).toBe('checkout_sessions')
    })
  })
})
