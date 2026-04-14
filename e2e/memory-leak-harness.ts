import { execSync } from 'node:child_process'

export type MemoryLeakSettings = {
  warmupIterations: number
  testIterations: number
  settleMs: number
  slopeThresholdKb: number
  growthThresholdMb: number
}

export type MemoryLeakIterationResult = {
  sawTimeLimit: boolean
}

export type MemoryLeakResult = {
  settings: MemoryLeakSettings
  totalIterations: number
  timeLimitCount: number
  rssSamplesByIterationKb: Array<number | null>
  postWarmupSamplesKb: number[]
  slopeKbPerIteration: number
  totalGrowthMb: number
  passesThresholds: boolean
}

const decoder = new TextDecoder()

export function getRssKb(pid: number): number | null {
  try {
    const raw = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim()
    const kb = parseInt(raw, 10)
    return Number.isFinite(kb) ? kb : null
  } catch {
    return null
  }
}

/** Least-squares slope: KB growth per iteration. */
export function linearRegressionSlope(ys: number[]): number {
  const n = ys.length
  if (n < 2) return 0
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0
  for (let i = 0; i < n; i++) {
    sumX += i
    sumY += ys[i]
    sumXY += i * ys[i]
    sumXX += i * i
  }
  return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX)
}

export async function drainNdjsonResponse(res: Response): Promise<unknown[]> {
  const reader = res.body?.getReader()
  if (!reader) return []

  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
  }
  buffer += decoder.decode()

  const messages: unknown[] = []
  for (const line of buffer.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    messages.push(JSON.parse(trimmed))
  }
  return messages
}

export function hasTimeLimitEof(messages: unknown[]): boolean {
  return messages.some((message) => {
    if (!message || typeof message !== 'object') return false
    if (!('type' in message) || message.type !== 'eof') return false
    if (!('eof' in message) || !message.eof || typeof message.eof !== 'object') return false
    return 'reason' in message.eof && message.eof.reason === 'time_limit'
  })
}

export async function runMemoryLeakDetector(opts: {
  pid: number
  settings: MemoryLeakSettings
  iterate: (iteration: number) => Promise<MemoryLeakIterationResult>
}): Promise<MemoryLeakResult> {
  const { pid, settings, iterate } = opts
  const totalIterations = settings.warmupIterations + settings.testIterations
  const rssSamplesByIterationKb: Array<number | null> = []
  let timeLimitCount = 0

  for (let i = 0; i < totalIterations; i++) {
    const { sawTimeLimit } = await iterate(i)
    if (sawTimeLimit) timeLimitCount++

    await new Promise((resolve) => setTimeout(resolve, settings.settleMs))

    rssSamplesByIterationKb.push(getRssKb(pid))
  }

  const postWarmupSamplesKb = rssSamplesByIterationKb
    .slice(settings.warmupIterations)
    .filter((value): value is number => value !== null)

  const slopeKbPerIteration = linearRegressionSlope(postWarmupSamplesKb)
  const totalGrowthMb =
    postWarmupSamplesKb.length >= 2
      ? (postWarmupSamplesKb[postWarmupSamplesKb.length - 1] - postWarmupSamplesKb[0]) / 1024
      : 0

  return {
    settings,
    totalIterations,
    timeLimitCount,
    rssSamplesByIterationKb,
    postWarmupSamplesKb,
    slopeKbPerIteration,
    totalGrowthMb,
    passesThresholds:
      slopeKbPerIteration < settings.slopeThresholdKb &&
      totalGrowthMb < settings.growthThresholdMb,
  }
}

export function formatRssSamplesTable(result: MemoryLeakResult): string {
  const lines = ['  RSS samples (MB):', '   iter  │  RSS (MB)  │  delta', '  ──────┼────────────┼────────']

  for (let i = 0; i < result.rssSamplesByIterationKb.length; i++) {
    const current = result.rssSamplesByIterationKb[i]
    const previous = i > 0 ? result.rssSamplesByIterationKb[i - 1] : null
    const mb = current === null ? '   n/a' : (current / 1024).toFixed(1).padStart(8)
    const delta =
      current === null || previous === null
        ? '   n/a'
        : (((current - previous) / 1024).toFixed(1)).padStart(6)
    const marker = i + 1 === result.settings.warmupIterations + 1 ? ' ← warmup end' : ''
    lines.push(`  ${String(i + 1).padStart(4)}  │  ${mb}  │  ${delta}${marker}`)
  }

  return lines.join('\n')
}

export function formatMemoryLeakSummary(result: MemoryLeakResult): string {
  const baseline = result.postWarmupSamplesKb[0]
  const final = result.postWarmupSamplesKb[result.postWarmupSamplesKb.length - 1]

  return [
    `  Canary: ${result.timeLimitCount}/${result.totalIterations} windows ended by time_limit (${((result.timeLimitCount / result.totalIterations) * 100).toFixed(0)}%)`,
    '',
    '  Post-warmup analysis:',
    `    Baseline RSS:   ${baseline === undefined ? 'n/a' : (baseline / 1024).toFixed(1) + ' MB'}`,
    `    Final RSS:      ${final === undefined ? 'n/a' : (final / 1024).toFixed(1) + ' MB'}`,
    `    Total growth:   ${result.totalGrowthMb.toFixed(1)} MB`,
    `    Slope:          ${result.slopeKbPerIteration.toFixed(1)} KB/iteration`,
  ].join('\n')
}
