/**
 * Tests for ERD Layout Utility
 */

import { describe, it, expect } from 'vitest'
import {
  layoutERD,
  layoutERDSync,
  calculateViewportBounds,
  type TableMetadata,
  type TableRelationship,
} from '../erd-layout'

function rectanglesOverlap(
  a: { x: number; y: number; width?: number; height?: number },
  b: { x: number; y: number; width?: number; height?: number }
): boolean {
  const gutter = 8

  return !(
    a.x + (a.width ?? 0) + gutter <= b.x ||
    b.x + (b.width ?? 0) + gutter <= a.x ||
    a.y + (a.height ?? 0) + gutter <= b.y ||
    b.y + (b.height ?? 0) + gutter <= a.y
  )
}

describe('ERD Layout', () => {
  describe('layoutERD', () => {
    it('should handle empty input', async () => {
      const result = await layoutERD([])
      expect(result.nodes).toHaveLength(0)
      expect(result.edges).toHaveLength(0)
    })

    it('should layout a single table', async () => {
      const tables: TableMetadata[] = [
        {
          name: 'customers',
          columns: ['id', 'email', 'name'],
          expanded: true,
        },
      ]

      const result = await layoutERD(tables)
      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0].id).toBe('customers')
      expect(result.nodes[0].position).toBeDefined()
      expect(result.nodes[0].data.tableName).toBe('customers')
      expect(result.nodes[0].data.columns).toHaveLength(3)
    })

    it('should layout multiple tables', async () => {
      const tables: TableMetadata[] = [
        { name: 'customers', columns: ['id', 'email', 'name'], expanded: true },
        { name: 'invoices', columns: ['id', 'customer_id', 'amount'], expanded: true },
        { name: 'products', columns: ['id', 'name', 'price'], expanded: false },
      ]

      const result = await layoutERD(tables)
      expect(result.nodes).toHaveLength(3)

      // Verify all nodes have positions
      result.nodes.forEach((node) => {
        expect(node.position.x).toBeDefined()
        expect(node.position.y).toBeDefined()
      })

      for (let i = 0; i < result.nodes.length; i++) {
        for (let j = i + 1; j < result.nodes.length; j++) {
          expect(
            rectanglesOverlap(
              {
                x: result.nodes[i].position.x,
                y: result.nodes[i].position.y,
                width: result.nodes[i].width,
                height: result.nodes[i].height,
              },
              {
                x: result.nodes[j].position.x,
                y: result.nodes[j].position.y,
                width: result.nodes[j].width,
                height: result.nodes[j].height,
              }
            )
          ).toBe(false)
        }
      }

      // Verify expanded state is preserved
      const productsNode = result.nodes.find((n) => n.id === 'products')
      expect(productsNode?.data.expanded).toBe(false)
    })

    it('should handle relationships between tables', async () => {
      const tables: TableMetadata[] = [
        { name: 'customers', columns: ['id', 'email'], expanded: true },
        { name: 'invoices', columns: ['id', 'customer_id', 'amount'], expanded: true },
      ]

      const relationships: TableRelationship[] = [
        {
          fromTable: 'invoices',
          fromColumn: 'customer_id',
          toTable: 'customers',
          toColumn: 'id',
        },
      ]

      const result = await layoutERD(tables, relationships)
      expect(result.nodes).toHaveLength(2)
      expect(result.edges).toHaveLength(1)
      expect(result.edges[0].source).toBe('invoices')
      expect(result.edges[0].target).toBe('customers')
      expect(result.edges[0].label).toBe('customer_id -> customers.id')
    })

    it('should handle large number of tables (100+)', async () => {
      const tables: TableMetadata[] = []
      for (let i = 0; i < 150; i++) {
        tables.push({
          name: `table_${i}`,
          columns: [`col_${i}_1`, `col_${i}_2`, `col_${i}_3`],
          expanded: i % 2 === 0, // Alternate expanded/collapsed
          rowCount: i * 100,
        })
      }

      const result = await layoutERD(tables)
      expect(result.nodes).toHaveLength(150)

      // Verify no overlapping positions (basic check)
      const positions = new Set()
      result.nodes.forEach((node) => {
        const posKey = `${Math.floor(node.position.x)},${Math.floor(node.position.y)}`
        expect(positions.has(posKey)).toBe(false) // No exact duplicates
        positions.add(posKey)
      })

      for (let i = 0; i < result.nodes.length; i++) {
        for (let j = i + 1; j < result.nodes.length; j++) {
          expect(
            rectanglesOverlap(
              {
                x: result.nodes[i].position.x,
                y: result.nodes[i].position.y,
                width: result.nodes[i].width,
                height: result.nodes[i].height,
              },
              {
                x: result.nodes[j].position.x,
                y: result.nodes[j].position.y,
                width: result.nodes[j].width,
                height: result.nodes[j].height,
              }
            )
          ).toBe(false)
        }
      }
    })

    it('should support string array columns', async () => {
      const tables: TableMetadata[] = [
        { name: 'test', columns: ['col1', 'col2', 'col3'], expanded: true },
      ]

      const result = await layoutERD(tables)
      expect(result.nodes[0].data.columns).toHaveLength(3)
      expect(result.nodes[0].data.columns[0].name).toBe('col1')
    })

    it('should support detailed column objects', async () => {
      const tables: TableMetadata[] = [
        {
          name: 'test',
          columns: [
            { name: 'id', type: 'bigint', isPrimaryKey: true },
            { name: 'email', type: 'text', nullable: true },
          ],
          expanded: true,
        },
      ]

      const result = await layoutERD(tables)
      expect(result.nodes[0].data.columns[0].isPrimaryKey).toBe(true)
      expect(result.nodes[0].data.columns[1].nullable).toBe(true)
    })

    it('should honor measured node sizes when laying out tall tables', async () => {
      const tables: TableMetadata[] = [
        { name: 'customers', columns: new Array(18).fill('col'), expanded: false },
        { name: 'invoices', columns: new Array(18).fill('col'), expanded: false },
      ]

      const result = await layoutERD(tables, [], {
        measuredNodeSizes: {
          customers: { width: 280, height: 520 },
          invoices: { width: 280, height: 520 },
        },
      })

      expect(result.nodes).toHaveLength(2)
      expect(
        rectanglesOverlap(
          {
            x: result.nodes[0].position.x,
            y: result.nodes[0].position.y,
            width: result.nodes[0].width,
            height: result.nodes[0].height,
          },
          {
            x: result.nodes[1].position.x,
            y: result.nodes[1].position.y,
            width: result.nodes[1].width,
            height: result.nodes[1].height,
          }
        )
      ).toBe(false)
    })

    it('should apply custom layout options', async () => {
      const tables: TableMetadata[] = [
        { name: 'table1', columns: ['col1'], expanded: true },
        { name: 'table2', columns: ['col2'], expanded: true },
      ]

      const result = await layoutERD(tables, [], {
        direction: 'RIGHT',
        nodeSpacing: 100,
        algorithm: 'stress',
      })

      expect(result.nodes).toHaveLength(2)
    })
  })

  describe('layoutERDSync', () => {
    it('should provide synchronous fallback layout', () => {
      const tables: TableMetadata[] = [
        { name: 'customers', columns: ['id', 'email'], expanded: true },
        { name: 'invoices', columns: ['id', 'customer_id'], expanded: false },
      ]

      const result = layoutERDSync(tables)
      expect(result.nodes).toHaveLength(2)
      expect(result.nodes[0].position).toBeDefined()
      expect(result.nodes[1].position).toBeDefined()
    })

    it('should handle relationships in sync mode', () => {
      const tables: TableMetadata[] = [
        { name: 'customers', columns: ['id'], expanded: true },
        { name: 'invoices', columns: ['id', 'customer_id'], expanded: true },
      ]

      const relationships: TableRelationship[] = [
        {
          fromTable: 'invoices',
          fromColumn: 'customer_id',
          toTable: 'customers',
          toColumn: 'id',
        },
      ]

      const result = layoutERDSync(tables, relationships)
      expect(result.edges).toHaveLength(1)
    })
  })

  describe('calculateViewportBounds', () => {
    it('should calculate bounds for empty nodes', () => {
      const bounds = calculateViewportBounds([])
      expect(bounds.width).toBeGreaterThan(0)
      expect(bounds.height).toBeGreaterThan(0)
    })

    it('should calculate bounds for positioned nodes', () => {
      const nodes = [
        {
          id: 'table1',
          type: 'erdTable',
          position: { x: 0, y: 0 },
          data: { tableName: 'table1', columns: [], expanded: true },
          width: 280,
          height: 200,
        },
        {
          id: 'table2',
          type: 'erdTable',
          position: { x: 500, y: 300 },
          data: { tableName: 'table2', columns: [], expanded: true },
          width: 280,
          height: 150,
        },
      ]

      const bounds = calculateViewportBounds(nodes)
      expect(bounds.x).toBeLessThan(0) // Includes padding
      expect(bounds.y).toBeLessThan(0) // Includes padding
      expect(bounds.width).toBeGreaterThan(780) // 500 + 280 + padding
      expect(bounds.height).toBeGreaterThan(450) // 300 + 150 + padding
    })
  })
})
