'use client'

/**
 * Example component demonstrating usePGlite hook
 *
 * Shows loading states, error handling, and basic query execution
 */

import { usePGlite } from '@/lib/pglite'
import { useState } from 'react'

export default function ExplorerExample() {
  const { status, error, query, manifest } = usePGlite()
  const [queryResult, setQueryResult] = useState<Record<string, unknown>[] | null>(null)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [isQuerying, setIsQuerying] = useState(false)

  // Loading state
  if (status === 'loading') {
    return (
      <div style={{ padding: '2rem' }}>
        <h2>Schema Explorer</h2>
        <p>Loading database...</p>
        <div style={{ marginTop: '1rem', color: '#666' }}>
          <small>Initializing PGlite and hydrating from static artifacts</small>
        </div>
      </div>
    )
  }

  // Error state
  if (status === 'error') {
    return (
      <div style={{ padding: '2rem' }}>
        <h2>Schema Explorer</h2>
        <div
          style={{
            padding: '1rem',
            backgroundColor: '#fee',
            border: '1px solid #fcc',
            borderRadius: '4px',
            marginTop: '1rem',
          }}
        >
          <strong>Error:</strong> {error}
        </div>
        <div style={{ marginTop: '1rem', color: '#666' }}>
          <small>
            Make sure the bootstrap artifacts exist in <code>/public/explorer-data/</code>
          </small>
        </div>
      </div>
    )
  }

  // Ready state - database is initialized
  const handleExampleQuery = async () => {
    setIsQuerying(true)
    setQueryError(null)
    setQueryResult(null)

    try {
      // Example query: Get top 10 customers with their subscription count
      const result = await query(`
        SELECT
          c.id,
          c._raw_data->>'email' as email,
          c._raw_data->>'name' as name,
          COUNT(s.id) as subscription_count
        FROM stripe.customers c
        LEFT JOIN stripe.subscriptions s ON s._raw_data->>'customer' = c.id
        GROUP BY c.id, c._raw_data
        ORDER BY subscription_count DESC
        LIMIT 10
      `)

      setQueryResult(result.rows)
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : 'Unknown query error')
    } finally {
      setIsQuerying(false)
    }
  }

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h2>Schema Explorer (PGlite)</h2>

      {/* Database Status */}
      <div
        style={{
          padding: '1rem',
          backgroundColor: '#efe',
          border: '1px solid #cfc',
          borderRadius: '4px',
          marginBottom: '1rem',
        }}
      >
        <strong>Status:</strong> {status} ✓
      </div>

      {/* Manifest Info */}
      {manifest && (
        <div style={{ marginBottom: '1rem' }}>
          <h3>Database Manifest</h3>
          <ul style={{ color: '#666' }}>
            <li>Total Tables: {manifest.totalTables}</li>
            <li>Core Tables: {manifest.coreTables.length}</li>
            <li>Long-Tail Tables: {manifest.longTailTables.length}</li>
            <li>API Version: {manifest.apiVersion}</li>
            <li>Generated: {new Date(manifest.timestamp).toLocaleString()}</li>
          </ul>
        </div>
      )}

      {/* Example Query */}
      <div style={{ marginTop: '2rem' }}>
        <h3>Example Query</h3>
        <button
          onClick={handleExampleQuery}
          disabled={isQuerying}
          style={{
            padding: '0.5rem 1rem',
            backgroundColor: isQuerying ? '#ccc' : '#0070f3',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: isQuerying ? 'not-allowed' : 'pointer',
            fontSize: '1rem',
          }}
        >
          {isQuerying ? 'Running...' : 'Run: Top Customers by Subscription Count'}
        </button>

        {/* Query Error */}
        {queryError && (
          <div
            style={{
              marginTop: '1rem',
              padding: '1rem',
              backgroundColor: '#fee',
              border: '1px solid #fcc',
              borderRadius: '4px',
            }}
          >
            <strong>Query Error:</strong> {queryError}
          </div>
        )}

        {/* Query Results */}
        {queryResult && (
          <div style={{ marginTop: '1rem' }}>
            <h4>Results ({queryResult.length} rows)</h4>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                marginTop: '0.5rem',
              }}
            >
              <thead>
                <tr style={{ backgroundColor: '#f5f5f5' }}>
                  <th style={{ padding: '0.5rem', textAlign: 'left', border: '1px solid #ddd' }}>
                    Customer ID
                  </th>
                  <th style={{ padding: '0.5rem', textAlign: 'left', border: '1px solid #ddd' }}>
                    Email
                  </th>
                  <th style={{ padding: '0.5rem', textAlign: 'left', border: '1px solid #ddd' }}>
                    Name
                  </th>
                  <th style={{ padding: '0.5rem', textAlign: 'right', border: '1px solid #ddd' }}>
                    Subscriptions
                  </th>
                </tr>
              </thead>
              <tbody>
                {queryResult.map((row, i) => (
                  <tr key={i}>
                    <td style={{ padding: '0.5rem', border: '1px solid #ddd' }}>
                      <code>{String(row.id)}</code>
                    </td>
                    <td style={{ padding: '0.5rem', border: '1px solid #ddd' }}>
                      {String(row.email || '-')}
                    </td>
                    <td style={{ padding: '0.5rem', border: '1px solid #ddd' }}>
                      {String(row.name || '-')}
                    </td>
                    <td style={{ padding: '0.5rem', textAlign: 'right', border: '1px solid #ddd' }}>
                      {String(row.subscription_count)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Table List */}
      {manifest && (
        <div style={{ marginTop: '2rem' }}>
          <h3>Available Tables</h3>
          <details>
            <summary style={{ cursor: 'pointer', marginBottom: '0.5rem' }}>
              Show all {manifest.totalTables} tables
            </summary>
            <div style={{ paddingLeft: '1rem' }}>
              <h4>Core Tables ({manifest.coreTables.length})</h4>
              <ul style={{ color: '#666', fontSize: '0.9rem' }}>
                {manifest.coreTables.map((table) => (
                  <li key={table}>
                    <code>stripe.{table}</code> ({manifest.manifest[table]} rows)
                  </li>
                ))}
              </ul>

              <h4>Long-Tail Tables ({manifest.longTailTables.length})</h4>
              <ul style={{ color: '#666', fontSize: '0.9rem' }}>
                {manifest.longTailTables.map((table) => (
                  <li key={table}>
                    <code>stripe.{table}</code> ({manifest.manifest[table]} rows)
                  </li>
                ))}
              </ul>
            </div>
          </details>
        </div>
      )}
    </div>
  )
}
