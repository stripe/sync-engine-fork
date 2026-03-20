/**
 * FK Survival Probe Test
 *
 * Verifies whether foreign key relationships survive the OpenAPI → PGlite projection.
 * This test loads the bootstrap.sql artifact and queries for FK constraints on core tables.
 *
 * Run with: npm test -- fk-probe.test.ts
 */

import { PGlite } from '@electric-sql/pglite'
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import type { VersionIndex } from '@/types/version-index'

describe('FK Survival Probe', () => {
  let db: PGlite
  const versionIndexPath = path.join(__dirname, '../../../public/explorer-data/index.json')
  const versionIndex = JSON.parse(fs.readFileSync(versionIndexPath, 'utf-8')) as VersionIndex
  const bootstrapPath = path.join(
    __dirname,
    `../../../public/explorer-data/${versionIndex.defaultVersion}/bootstrap.sql`
  )

  beforeAll(async () => {
    // Create PGlite instance
    db = await PGlite.create()

    // Load bootstrap SQL
    const sqlContent = fs.readFileSync(bootstrapPath, 'utf-8')
    await db.exec(sqlContent)
  })

  it('should load bootstrap.sql successfully', async () => {
    const result = await db.query(
      "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = 'stripe'"
    )
    const count = (result.rows[0] as { count: number }).count
    expect(count).toBeGreaterThan(0)
    console.log(`✓ Loaded ${count} tables from bootstrap.sql`)
  })

  it('should probe FK relationships on customers table', async () => {
    const result = await db.query(`
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'stripe'
        AND tc.table_name = 'customers'
    `)

    console.log(`customers FK count: ${result.rows.length}`)
    if (result.rows.length > 0) {
      console.log('customers FKs:', result.rows)
    } else {
      console.log('⚠ No FK constraints found on customers table')
    }

    // We don't expect FKs to exist, but record the result
    expect(result.rows).toBeDefined()
  })

  it('should probe FK relationships on subscriptions table', async () => {
    const result = await db.query(`
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'stripe'
        AND tc.table_name = 'subscriptions'
    `)

    console.log(`subscriptions FK count: ${result.rows.length}`)
    if (result.rows.length > 0) {
      console.log('subscriptions FKs:', result.rows)
    } else {
      console.log('⚠ No FK constraints found on subscriptions table')
    }

    expect(result.rows).toBeDefined()
  })

  it('should probe FK relationships on invoices table', async () => {
    const result = await db.query(`
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'stripe'
        AND tc.table_name = 'invoices'
    `)

    console.log(`invoices FK count: ${result.rows.length}`)
    if (result.rows.length > 0) {
      console.log('invoices FKs:', result.rows)
    } else {
      console.log('⚠ No FK constraints found on invoices table')
    }

    expect(result.rows).toBeDefined()
  })

  it('should count total FK relationships in schema', async () => {
    const result = await db.query(`
      SELECT COUNT(*) as fk_count
      FROM information_schema.table_constraints
      WHERE constraint_type = 'FOREIGN KEY'
        AND table_schema = 'stripe'
    `)

    const fkCount = (result.rows[0] as { fk_count: number }).fk_count
    console.log(`\nTotal FK relationships in stripe schema: ${fkCount}`)

    if (fkCount === 0) {
      console.log('\n⚠ CONCLUSION: No FK constraints survive the OpenAPI → PGlite projection')
      console.log(
        '  Recommendation: Ship ERD without edges, or implement relationships.json sidecar'
      )
      console.log(
        '  Note: Implicit relationships exist in text columns (e.g., customer field in invoices)'
      )
    } else {
      console.log(`\n✓ CONCLUSION: ${fkCount} FK relationships detected in schema`)
    }

    // Record result - test passes either way
    expect(typeof fkCount).toBe('number')
  })

  it('should identify implicit relationships from column names', async () => {
    // Find columns that likely represent foreign keys based on naming patterns
    const result = await db.query(`
      SELECT
        table_name,
        column_name,
        data_type
      FROM information_schema.columns
      WHERE table_schema = 'stripe'
        AND (
          column_name LIKE '%_id'
          OR column_name IN ('customer', 'account', 'subscription', 'invoice', 'charge', 'payment_method')
        )
        AND data_type = 'text'
      ORDER BY table_name, column_name
      LIMIT 50
    `)

    console.log(
      `\nFound ${result.rows.length} implicit FK candidates (text columns with ID-like names):`
    )
    result.rows.slice(0, 10).forEach((row) => {
      const r = row as { table_name: string; column_name: string }
      console.log(`  - ${r.table_name}.${r.column_name}`)
    })

    if (result.rows.length > 10) {
      console.log(`  ... and ${result.rows.length - 10} more`)
    }

    expect(result.rows.length).toBeGreaterThan(0)
  })
})
