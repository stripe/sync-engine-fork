import { describe, expect, it } from 'vitest'
import { buildExampleSections } from '../src/writer.js'

describe('buildExampleSections', () => {
  it('returns empty array when no streams are present', () => {
    expect(buildExampleSections([])).toEqual([])
  })

  it('returns empty array when streams lack the required fields', () => {
    const sections = buildExampleSections([
      { streamName: 'subscriptions', headers: ['id'] }, // no 'status'
    ])
    expect(sections).toEqual([])
  })

  it('includes subscription status section when subscriptions.status is present', () => {
    const sections = buildExampleSections([
      { streamName: 'subscriptions', headers: ['id', 'customer', 'status', 'created'] },
    ])
    expect(sections).toHaveLength(1)
    const s = sections[0]
    expect(s.title).toBe('Subscription Status')
    expect(s.chartType).toBe('PIE')
    expect(s.tableHeader).toEqual(['Status', 'Count'])
    // All 8 statuses should be present
    expect(s.rows).toHaveLength(8)
    expect(s.rows.map((r) => r[0])).toContain('active')
    expect(s.rows.map((r) => r[0])).toContain('canceled')
    // Formulas reference the correct column ('subscriptions'!C2:C = index 2 = column C)
    expect(s.rows[0][1]).toContain("'subscriptions'!C2:C")
  })

  it('includes customer growth section when customers.created is present', () => {
    const sections = buildExampleSections([
      { streamName: 'customers', headers: ['id', 'email', 'created'] },
    ])
    expect(sections).toHaveLength(1)
    const s = sections[0]
    expect(s.title).toBe('New Customers by Month')
    expect(s.chartType).toBe('COLUMN')
    expect(s.rows).toHaveLength(6) // last 6 months
    // Formulas should reference customers.created (column C = index 2)
    expect(s.rows[0][1]).toContain("'customers'!C2:C")
    // Formula should use EDATE for Unix timestamp conversion
    expect(s.rows[0][1]).toContain('EDATE')
    expect(s.rows[0][1]).toContain('DATE(1970,1,1)')
  })

  it('includes payment volume section when payment_intents has status and amount', () => {
    const sections = buildExampleSections([
      { streamName: 'payment_intents', headers: ['id', 'amount', 'currency', 'status'] },
    ])
    // Should include payment volume section (status=col D idx 3, amount=col B idx 1)
    const paymentSection = sections.find((s) => s.title === 'Payment Volume by Status')
    expect(paymentSection).toBeDefined()
    expect(paymentSection!.chartType).toBe('BAR')
    expect(paymentSection!.tableHeader).toEqual(['Status', 'Count', 'Total Amount'])
    expect(paymentSection!.rows[0][0]).toBe('succeeded')
  })

  it('includes revenue by currency only when currency, amount, AND status are all present', () => {
    // Missing status → no revenue section
    const withoutStatus = buildExampleSections([
      { streamName: 'payment_intents', headers: ['id', 'amount', 'currency'] },
    ])
    expect(withoutStatus.find((s) => s.title === 'Revenue by Currency')).toBeUndefined()

    // All three present → included
    const withAll = buildExampleSections([
      { streamName: 'payment_intents', headers: ['id', 'amount', 'currency', 'status'] },
    ])
    expect(withAll.find((s) => s.title === 'Revenue by Currency')).toBeDefined()
  })

  it('includes products section when products.active is present', () => {
    const sections = buildExampleSections([
      { streamName: 'products', headers: ['id', 'name', 'active'] },
    ])
    const s = sections.find((s) => s.title === 'Products: Active vs Archived')
    expect(s).toBeDefined()
    expect(s!.rows).toHaveLength(2)
    expect(s!.rows[0][0]).toBe('Active')
    expect(s!.rows[0][1]).toContain('"true"')
  })

  it('includes multi-table invoice section only when both invoices and subscriptions have required fields', () => {
    // Only invoices — no section
    const invoicesOnly = buildExampleSections([
      { streamName: 'invoices', headers: ['id', 'subscription', 'amount_paid'] },
    ])
    expect(invoicesOnly.find((s) => s.title.includes('Invoice'))).toBeUndefined()

    // Both present — section included
    const both = buildExampleSections([
      { streamName: 'invoices', headers: ['id', 'subscription', 'amount_paid'] },
      { streamName: 'subscriptions', headers: ['id', 'customer', 'status'] },
    ])
    const s = both.find((s) => s.title.includes('Invoice'))
    expect(s).toBeDefined()
    expect(s!.tableHeader).toEqual(['Subscription Status', 'Invoice Revenue'])
    // Formula should reference both sheets
    expect(s!.rows[0][1]).toContain("'invoices'")
    expect(s!.rows[0][1]).toContain("'subscriptions'")
    expect(s!.rows[0][1]).toContain('COUNTIFS')
    // Guard against empty subscription references
    expect(s!.rows[0][1]).toContain('<>""')
  })

  it('returns all 6 sections when all streams are present', () => {
    const sections = buildExampleSections([
      { streamName: 'subscriptions', headers: ['id', 'customer', 'status', 'currency', 'created'] },
      { streamName: 'customers', headers: ['id', 'email', 'created'] },
      { streamName: 'payment_intents', headers: ['id', 'amount', 'currency', 'status'] },
      { streamName: 'products', headers: ['id', 'name', 'active'] },
      { streamName: 'invoices', headers: ['id', 'subscription', 'amount_paid', 'status'] },
    ])
    expect(sections).toHaveLength(6)
  })

  it('uses correct column letters for fields at various positions', () => {
    // status at index 0 → column A
    const sections = buildExampleSections([
      { streamName: 'subscriptions', headers: ['status'] },
    ])
    expect(sections[0].rows[0][1]).toContain("'subscriptions'!A2:A")

    // status at index 25 → column Z
    const headers26 = Array.from({ length: 26 }, (_, i) => (i < 25 ? `field_${i}` : 'status'))
    const sections26 = buildExampleSections([{ streamName: 'subscriptions', headers: headers26 }])
    expect(sections26[0].rows[0][1]).toContain("'subscriptions'!Z2:Z")

    // status at index 26 → column AA
    const headers27 = Array.from({ length: 27 }, (_, i) => (i < 26 ? `field_${i}` : 'status'))
    const sections27 = buildExampleSections([{ streamName: 'subscriptions', headers: headers27 }])
    expect(sections27[0].rows[0][1]).toContain("'subscriptions'!AA2:AA")
  })
})
