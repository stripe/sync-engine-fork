import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  drainNdjsonResponse,
  formatMemoryLeakSummary,
  hasTimeLimitEof,
  runMemoryLeakDetector,
  type MemoryLeakSettings,
} from './memory-leak-harness.js'

const DETECTOR_SETTINGS: MemoryLeakSettings = {
  warmupIterations: 6,
  testIterations: 12,
  settleMs: 50,
  slopeThresholdKb: 3000,
  growthThresholdMb: 300,
}

const SYNTHETIC_LEAK_BYTES = 8 * 1024 * 1024

const children = new Set<ChildProcess>()

function spawnSyntheticServer(leakBytesPerRequest: number): Promise<{ proc: ChildProcess; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const code = [
      'import http from "node:http";',
      'const retained = [];',
      `const leakBytesPerRequest = ${leakBytesPerRequest};`,
      'const server = http.createServer((req, res) => {',
      '  if (req.url === "/health") {',
      '    res.writeHead(200, { "content-type": "application/json" });',
      '    res.end(JSON.stringify({ ok: true }));',
      '    return;',
      '  }',
      '  if (req.url?.startsWith("/pipeline_setup")) {',
      '    res.writeHead(200, { "content-type": "application/x-ndjson" });',
      '    res.end(JSON.stringify({ type: "control" }) + "\\n");',
      '    return;',
      '  }',
      '  if (req.url?.startsWith("/pipeline_sync")) {',
      '    if (leakBytesPerRequest > 0) retained.push(Buffer.alloc(leakBytesPerRequest, 1));',
      '    res.writeHead(200, { "content-type": "application/x-ndjson" });',
      '    res.end(JSON.stringify({ type: "eof", eof: { reason: "time_limit" } }) + "\\n");',
      '    return;',
      '  }',
      '  res.writeHead(404);',
      '  res.end("not found");',
      '});',
      'server.listen(0, "127.0.0.1", () => {',
      '  const addr = server.address();',
      '  console.log(`READY:${addr.port}`);',
      '});',
    ].join('\n')

    const proc = spawn('node', ['--input-type=module', '-e', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcess
    children.add(proc)

    let output = ''
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`Synthetic server did not start within 5s\noutput: ${output}`))
    }, 5_000)

    proc.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/READY:(\d+)/)
      if (!match) return
      clearTimeout(timeout)
      resolve({ proc, baseUrl: `http://127.0.0.1:${match[1]}` })
    })

    proc.stderr!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })

    proc.on('error', (err: Error) => {
      clearTimeout(timeout)
      reject(err)
    })

    proc.on('exit', (code: number | null) => {
      clearTimeout(timeout)
      if (!output.includes('READY:')) {
        reject(new Error(`Synthetic server exited with code ${code}\noutput: ${output}`))
      }
    })
  })
}

async function runSyntheticScenario(leakBytesPerRequest: number) {
  const { proc, baseUrl } = await spawnSyntheticServer(leakBytesPerRequest)

  const setupRes = await fetch(`${baseUrl}/pipeline_setup`, { method: 'POST' })
  expect(setupRes.ok).toBe(true)
  await drainNdjsonResponse(setupRes)

  const result = await runMemoryLeakDetector({
    pid: proc.pid!,
    settings: DETECTOR_SETTINGS,
    iterate: async () => {
      const res = await fetch(`${baseUrl}/pipeline_sync?time_limit=0.1`, { method: 'POST' })
      expect(res.ok).toBe(true)
      const messages = await drainNdjsonResponse(res)
      return { sawTimeLimit: hasTimeLimitEof(messages) }
    },
  })

  return result
}

afterEach(async () => {
  for (const child of children) {
    if (child.pid) child.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      setTimeout(resolve, 500)
    })
    children.delete(child)
  }
})

describe('memory leak harness', { timeout: 120_000 }, () => {
  it('does not flag a stable synthetic process', async () => {
    const result = await runSyntheticScenario(0)

    console.log(formatMemoryLeakSummary(result))

    expect(result.timeLimitCount).toBe(result.totalIterations)
    expect(result.passesThresholds).toBe(true)
    expect(result.slopeKbPerIteration).toBeLessThan(DETECTOR_SETTINGS.slopeThresholdKb)
  })

  it('flags an intentionally leaky synthetic process', async () => {
    const result = await runSyntheticScenario(SYNTHETIC_LEAK_BYTES)

    console.log(formatMemoryLeakSummary(result))

    expect(result.timeLimitCount).toBe(result.totalIterations)
    expect(result.passesThresholds).toBe(false)
    expect(result.slopeKbPerIteration).toBeGreaterThan(DETECTOR_SETTINGS.slopeThresholdKb)
  })
})
