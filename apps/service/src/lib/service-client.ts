import createClient from 'openapi-fetch'
import type { paths } from './openapi.js'

export function createServiceClient(baseUrl: string) {
  return createClient<paths>({ baseUrl })
}

export type ServiceClient = ReturnType<typeof createServiceClient>
