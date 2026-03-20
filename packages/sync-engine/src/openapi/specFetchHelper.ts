import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { OpenApiSpec, ResolveSpecConfig, ResolvedOpenApiSpec } from './types'

const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'stripe-sync-openapi-cache')
const PUBLIC_V1_SPEC_REPO_PATH = 'openapi/spec3.json'
const LEGACY_PER_VERSION_SDK_SPEC = {
  repoPath: 'openapi/spec3.sdk.json',
  cacheSuffix: 'openapi.spec3.sdk.json',
} as const
const UNIFIED_V2_SDK_SPECS = [
  // Stripe first published unified /v2 specs under this filename on 2026-01-28.
  {
    repoPath: 'latest/openapi.sdk.spec3.json',
    cacheSuffix: 'latest.openapi.sdk.spec3.json',
  },
  // The repo later renamed the unified artifact to this filename.
  {
    repoPath: 'latest/openapi.spec3.sdk.json',
    cacheSuffix: 'latest.openapi.spec3.sdk.json',
  },
] as const
// Stripe added unified artifacts with /v2 endpoints on 2026-01-28.
const UNIFIED_V2_FIRST_API_VERSION = '2026-01-28'

type ResolvedRemoteSpecArtifact = {
  spec: OpenApiSpec
  source: 'cache' | 'github'
  cachePath: string
  commitSha?: string
}

type SdkSpecCandidate = {
  repoPath: string
  cacheSuffix: string
}

export async function resolveOpenApiSpec(config: ResolveSpecConfig): Promise<ResolvedOpenApiSpec> {
  const apiVersion = config.apiVersion
  if (!apiVersion || !/^\d{4}-\d{2}-\d{2}$/.test(apiVersion)) {
    throw new Error(`Invalid Stripe API version "${apiVersion}". Expected YYYY-MM-DD.`)
  }

  if (config.openApiSpecPath) {
    const explicitSpec = await readSpecFromPath(config.openApiSpecPath)
    return {
      apiVersion,
      spec: explicitSpec,
      source: 'explicit_path',
      cachePath: config.openApiSpecPath,
    }
  }

  const cacheDir = config.cacheDir ?? DEFAULT_CACHE_DIR
  const publicV1Spec = await resolveRemoteSpecArtifact({
    apiVersion,
    cacheDir,
    repoPath: PUBLIC_V1_SPEC_REPO_PATH,
    cacheSuffix: 'spec3.json',
    missingCommitError: `Could not resolve Stripe OpenAPI commit for API version ${apiVersion} and no local spec path was provided.`,
  })
  let mergedSpec = publicV1Spec.spec
  const sdkCandidates = getSdkSpecCandidates(apiVersion)
  const shouldMergeAllSdkCandidates = apiVersion >= UNIFIED_V2_FIRST_API_VERSION

  for (const sdkCandidate of sdkCandidates) {
    const sdkSpec = await tryResolveOptionalRemoteSpecArtifact({
      apiVersion,
      cacheDir,
      repoPath: sdkCandidate.repoPath,
      cacheSuffix: sdkCandidate.cacheSuffix,
    })
    if (sdkSpec) {
      mergedSpec = mergeSpecs(mergedSpec, sdkSpec.spec)
      if (!shouldMergeAllSdkCandidates) {
        break
      }
    }
  }

  return {
    apiVersion,
    spec: mergedSpec,
    source: publicV1Spec.source,
    cachePath: publicV1Spec.cachePath,
    commitSha: publicV1Spec.commitSha,
  }
}

async function readSpecFromPath(openApiSpecPath: string): Promise<OpenApiSpec> {
  const raw = await fs.readFile(openApiSpecPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Failed to parse OpenAPI spec at ${openApiSpecPath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  validateOpenApiSpec(parsed)
  return parsed
}

async function tryReadCachedSpec(cachePath: string): Promise<OpenApiSpec | null> {
  try {
    const raw = await fs.readFile(cachePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    validateOpenApiSpec(parsed)
    return parsed
  } catch {
    return null
  }
}

async function tryWriteCache(cachePath: string, spec: OpenApiSpec): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, JSON.stringify(spec), 'utf8')
  } catch {
    // Best effort only. Cache writes should never block migration flow.
  }
}

async function resolveRemoteSpecArtifact(config: {
  apiVersion: string
  cacheDir: string
  repoPath: string
  cacheSuffix: string
  missingCommitError: string
}): Promise<ResolvedRemoteSpecArtifact> {
  const resolved = await tryResolveRemoteSpecArtifact(config)
  if (resolved) {
    return resolved
  }
  throw new Error(config.missingCommitError)
}

async function tryResolveRemoteSpecArtifact(config: {
  apiVersion: string
  cacheDir: string
  repoPath: string
  cacheSuffix: string
}): Promise<ResolvedRemoteSpecArtifact | null> {
  const cachePath = getVersionedCachePath(config.cacheDir, config.apiVersion, config.cacheSuffix)
  const cachedSpec = await tryReadCachedSpec(cachePath)
  if (cachedSpec) {
    return {
      spec: cachedSpec,
      source: 'cache',
      cachePath,
    }
  }

  const commitSha = await resolveCommitShaForApiVersion(config.apiVersion, config.repoPath)
  if (!commitSha) {
    return null
  }

  const spec = await fetchSpecForCommit(commitSha, config.repoPath)
  validateOpenApiSpec(spec)
  await tryWriteCache(cachePath, spec)

  return {
    spec,
    source: 'github',
    cachePath,
    commitSha,
  }
}

async function tryResolveOptionalRemoteSpecArtifact(config: {
  apiVersion: string
  cacheDir: string
  repoPath: string
  cacheSuffix: string
}): Promise<ResolvedRemoteSpecArtifact | null> {
  try {
    return await tryResolveRemoteSpecArtifact(config)
  } catch {
    return null
  }
}

function getVersionedCachePath(cacheDir: string, apiVersion: string, cacheSuffix: string): string {
  const safeVersion = apiVersion.replace(/[^0-9a-zA-Z_-]/g, '_')
  const safeSuffix = cacheSuffix.replace(/[^0-9a-zA-Z_.-]/g, '_')
  return path.join(cacheDir, `${safeVersion}.${safeSuffix}`)
}

function getSdkSpecCandidates(apiVersion: string): readonly SdkSpecCandidate[] {
  // Prefer the per-version SDK artifact for older API versions.
  // Starting on 2026-01-28, merge any unified /v2 artifact we can find as well,
  // while retaining version-specific SDK metadata from the legacy file.
  if (apiVersion >= UNIFIED_V2_FIRST_API_VERSION) {
    return [...UNIFIED_V2_SDK_SPECS, LEGACY_PER_VERSION_SDK_SPEC]
  }
  return [LEGACY_PER_VERSION_SDK_SPEC, ...UNIFIED_V2_SDK_SPECS]
}

async function resolveCommitShaForApiVersion(
  apiVersion: string,
  repoPath: string
): Promise<string | null> {
  const until = `${apiVersion}T23:59:59Z`
  const url = new URL('https://api.github.com/repos/stripe/openapi/commits')
  url.searchParams.set('path', repoPath)
  url.searchParams.set('until', until)
  url.searchParams.set('per_page', '1')

  const response = await fetch(url, { headers: githubHeaders() })
  if (!response.ok) {
    throw new Error(
      `Failed to resolve Stripe OpenAPI commit (${response.status} ${response.statusText})`
    )
  }

  const json = (await response.json()) as Array<{ sha?: string }>
  const commitSha = json[0]?.sha
  return typeof commitSha === 'string' && commitSha.length > 0 ? commitSha : null
}

async function fetchSpecForCommit(commitSha: string, repoPath: string): Promise<OpenApiSpec> {
  const url = `https://raw.githubusercontent.com/stripe/openapi/${commitSha}/${repoPath}`
  const response = await fetch(url, { headers: githubHeaders() })
  if (!response.ok) {
    throw new Error(
      `Failed to download Stripe OpenAPI spec for commit ${commitSha} (${response.status} ${response.statusText})`
    )
  }

  const spec = (await response.json()) as unknown
  validateOpenApiSpec(spec)
  return spec
}

function mergeSpecs(publicV1Spec: OpenApiSpec, unifiedV2SdkSpec: OpenApiSpec): OpenApiSpec {
  const mergedPaths = { ...(publicV1Spec.paths ?? {}) }
  for (const [pathName, pathItem] of Object.entries(unifiedV2SdkSpec.paths ?? {})) {
    if (!pathName.startsWith('/v2/')) {
      continue
    }
    mergedPaths[pathName] = pathItem
  }

  const mergedSchemas = { ...(publicV1Spec.components?.schemas ?? {}) }
  for (const [schemaName, schema] of Object.entries(unifiedV2SdkSpec.components?.schemas ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(mergedSchemas, schemaName)) {
      mergedSchemas[schemaName] = schema
      continue
    }

    if (schemaName.startsWith('v2.')) {
      mergedSchemas[schemaName] = schema
      continue
    }

    const publicSchema = mergedSchemas[schemaName]
    if (isPlainObject(publicSchema) && isPlainObject(schema)) {
      mergedSchemas[schemaName] = mergeTopLevelSdkMetadata(publicSchema, schema)
    }
  }

  return {
    ...publicV1Spec,
    paths: mergedPaths,
    components: {
      ...(publicV1Spec.components ?? {}),
      schemas: mergedSchemas,
    },
  }
}

function mergeTopLevelSdkMetadata(
  publicSchema: Record<string, unknown>,
  sdkSchema: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...publicSchema }

  for (const [key, value] of Object.entries(sdkSchema)) {
    if (!key.startsWith('x-')) {
      continue
    }
    merged[key] = value
  }

  return merged
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validateOpenApiSpec(spec: unknown): asserts spec is OpenApiSpec {
  if (!spec || typeof spec !== 'object') {
    throw new Error('OpenAPI spec is not an object')
  }
  const candidate = spec as Partial<OpenApiSpec>
  if (typeof candidate.openapi !== 'string' || candidate.openapi.trim().length === 0) {
    throw new Error('OpenAPI spec is missing the "openapi" field')
  }
  if (!candidate.components || typeof candidate.components !== 'object') {
    throw new Error('OpenAPI spec is missing "components"')
  }
  if (!candidate.components.schemas || typeof candidate.components.schemas !== 'object') {
    throw new Error('OpenAPI spec is missing "components.schemas"')
  }
}

function githubHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'stripe-sync-engine-openapi',
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}
