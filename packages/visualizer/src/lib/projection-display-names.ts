const DISPLAY_NAME_ALIASES: Record<string, string> = {
  'v2.core.account_person': 'v2_core_persons',
  'v2.core.account_person_token': 'v2_core_person_tokens',
}

export function resolveProjectionDisplayName(
  tableName: string,
  resourceIds: string[] | undefined
): string {
  for (const resourceId of resourceIds ?? []) {
    const alias = DISPLAY_NAME_ALIASES[resourceId]
    if (alias) {
      return alias
    }
  }

  return tableName
}
