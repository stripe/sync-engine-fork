import { describe, expect, it } from 'vitest'
import { determineNamespace } from '../projection-namespace'

describe('determineNamespace', () => {
  it('prefers v2 path provenance over schema naming fallbacks', () => {
    expect(determineNamespace(['/v2/core/accounts'], 'account', 'accounts')).toBe('v2')
  })

  it('prefers v1 path provenance over a misleading v2 schema name', () => {
    expect(determineNamespace(['/v1/customers'], 'v2.core.customer', 'customers')).toBe('v1')
  })

  it('falls back to the source schema name when no path provenance exists', () => {
    expect(determineNamespace(undefined, 'v2.core.account', 'v2_core_accounts')).toBe('v2')
  })

  it('keeps compatibility and utility tables out of v1/v2 buckets', () => {
    expect(determineNamespace(undefined, 'compatibility_fallback', 'legacy_events')).toBe(
      'compatibility'
    )
    expect(determineNamespace(undefined, '', 'migration_meta')).toBe('utility')
  })
})
