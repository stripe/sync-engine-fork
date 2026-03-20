import type { NamespaceTag } from '../types/projection'

const UTILITY_TABLES = new Set(['migration_meta', 'sync_runs', 'webhook_events'])

export function determineNamespace(
  sourcePaths: string[] | undefined,
  sourceSchemaName: string,
  tableName: string
): NamespaceTag {
  if (UTILITY_TABLES.has(tableName)) {
    return 'utility'
  }

  if (sourcePaths?.some((pathName) => pathName.startsWith('/v2/'))) {
    return 'v2'
  }

  if (sourcePaths?.some((pathName) => pathName.startsWith('/v1/'))) {
    return 'v1'
  }

  if (sourceSchemaName.startsWith('v2.')) {
    return 'v2'
  }

  if (sourceSchemaName === 'compatibility_fallback') {
    return 'compatibility'
  }

  if (sourceSchemaName) {
    return 'v1'
  }

  return 'unclassified'
}
