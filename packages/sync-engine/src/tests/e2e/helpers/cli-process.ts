/**
 * CLI background process manager for integration tests
 * Manages starting/stopping the sync engine CLI
 */
import { spawn, execSync, ChildProcess } from 'child_process'
import * as fs from 'fs'
import { waitFor, sleep } from '../../testSetup'

export class CliProcess {
  private process: ChildProcess | null = null
  private logFile: string
  private cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
    this.logFile = `/tmp/cli-test-${Date.now()}.log`
  }

  async start(env: Record<string, string> = {}): Promise<void> {
    const logStream = fs.createWriteStream(this.logFile)

    this.process = spawn(
      'node',
      ['dist/cli/index.js', 'sync', 'all', '--listen-mode', 'websocket', '--listen-only'],
      {
        cwd: this.cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      }
    )

    this.process.stdout?.pipe(logStream)
    this.process.stderr?.pipe(logStream)

    await waitFor(() => this.isRunning() && this.getLogs().length > 0, 30000, {
      intervalMs: 1000,
      message: `CLI failed to start. Logs:\n${this.getLogs()}`,
    })
  }

  isRunning(): boolean {
    if (!this.process) return false
    try {
      process.kill(this.process.pid!, 0)
      return true
    } catch {
      return false
    }
  }

  async stop(): Promise<void> {
    if (this.process && this.isRunning()) {
      this.process.kill('SIGTERM')
      await sleep(2000)
    }
    this.process = null
  }

  getLogs(): string {
    try {
      return fs.readFileSync(this.logFile, 'utf-8')
    } catch {
      return ''
    }
  }

  getLogFile(): string {
    return this.logFile
  }
}

export function runCliCommand(
  command: string,
  args: string[],
  options: {
    cwd: string
    env?: Record<string, string>
    timeout?: number
  }
): string {
  const { cwd, env = {}, timeout = 120000 } = options
  const fullCommand = `node dist/cli/index.js ${command} ${args.join(' ')}`

  const result = execSync(fullCommand, {
    cwd,
    env: { ...process.env, ...env },
    timeout,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  return result
}

/**
 * Non-blocking variant of `runCliCommand`. Uses `spawn` so the event loop stays
 * alive (avoids Vitest worker RPC timeouts and ECONNRESET on long-running syncs).
 */
export function runCliCommandAsync(
  command: string,
  args: string[],
  options: {
    cwd: string
    env?: Record<string, string>
    timeout?: number
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { cwd, env = {}, timeout = 120000 } = options

  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/cli/index.js', command, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`runCliCommandAsync timed out after ${timeout}ms`))
    }, timeout)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code ?? 1,
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

export function buildCli(cwd: string): void {
  execSync('npm run build', { cwd, stdio: 'pipe' })
}
