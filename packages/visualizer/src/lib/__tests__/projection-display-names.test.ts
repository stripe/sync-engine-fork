import { describe, expect, it } from 'vitest'
import { resolveProjectionDisplayName } from '../projection-display-names'

describe('resolveProjectionDisplayName', () => {
  it('keeps ordinary table names unchanged', () => {
    expect(resolveProjectionDisplayName('customers', ['customer'])).toBe('customers')
    expect(resolveProjectionDisplayName('v2_core_accounts', ['v2.core.account'])).toBe(
      'v2_core_accounts'
    )
  })

  it('renames v2 account-person tables to match docs-style naming', () => {
    expect(
      resolveProjectionDisplayName('v2_core_account_persons', ['v2.core.account_person'])
    ).toBe('v2_core_persons')
    expect(
      resolveProjectionDisplayName('v2_core_account_person_tokens', [
        'v2.core.account_person_token',
      ])
    ).toBe('v2_core_person_tokens')
  })
})
