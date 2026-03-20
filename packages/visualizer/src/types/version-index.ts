/**
 * Version Index Schema
 *
 * Defines the structure of the version index file (index.json) that lists
 * all available API versions for the Stripe schema visualizer.
 *
 * Location: /explorer-data/index.json
 */

/**
 * Metadata for a single API version
 */
export interface VersionMetadata {
  /**
   * The API version identifier (e.g., "2024-06-20")
   */
  apiVersion: string

  /**
   * Human-readable label for the version (e.g., "2024-06-20 (Latest)")
   */
  label: string

  /**
   * Path to the manifest.json for this version
   * Example: "/explorer-data/2024-06-20/manifest.json"
   */
  manifestPath: string

  /**
   * Path to the bootstrap.sql or bootstrap.json for this version
   * Example: "/explorer-data/2024-06-20/bootstrap.sql"
   */
  bootstrapPath: string

  /**
   * Path to the projection.json for this version
   * Example: "/explorer-data/2024-06-20/projection.json"
   */
  projectionPath: string

  /**
   * Number of tables in this version
   */
  tableCount: number

  /**
   * Total number of rows across all tables
   */
  totalRows: number
}

/**
 * The version index structure
 */
export interface VersionIndex {
  /**
   * The default API version to load (e.g., "2024-06-20")
   */
  defaultVersion: string

  /**
   * List of all available API versions, ordered from newest to oldest
   */
  versions: VersionMetadata[]
}

/**
 * Example version index:
 *
 * ```json
 * {
 *   "defaultVersion": "2024-06-20",
 *   "versions": [
 *     {
 *       "apiVersion": "2024-06-20",
 *       "label": "2024-06-20 (Latest)",
 *       "manifestPath": "/explorer-data/2024-06-20/manifest.json",
 *       "bootstrapPath": "/explorer-data/2024-06-20/bootstrap.sql",
 *       "projectionPath": "/explorer-data/2024-06-20/projection.json",
 *       "tableCount": 120,
 *       "totalRows": 2500
 *     },
 *     {
 *       "apiVersion": "2023-10-16",
 *       "label": "2023-10-16",
 *       "manifestPath": "/explorer-data/2023-10-16/manifest.json",
 *       "bootstrapPath": "/explorer-data/2023-10-16/bootstrap.sql",
 *       "projectionPath": "/explorer-data/2023-10-16/projection.json",
 *       "tableCount": 115,
 *       "totalRows": 2300
 *     }
 *   ]
 * }
 * ```
 */
