import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const DEVCONTAINER_DIR = join(ROOT, '.devcontainer')

describe('devcontainer configuration', () => {
  it('devcontainer.json is valid JSON with required fields', () => {
    const path = join(DEVCONTAINER_DIR, 'devcontainer.json')
    expect(existsSync(path), '.devcontainer/devcontainer.json must exist').toBe(true)

    const config = JSON.parse(readFileSync(path, 'utf-8'))

    expect(config.name).toBeDefined()
    expect(config.dockerComposeFile).toBe('docker-compose.yml')
    expect(config.service).toBe('app')
    expect(config.workspaceFolder).toBeDefined()
    expect(config.postCreateCommand).toContain('pnpm install')
    expect(config.postCreateCommand).toContain('pnpm build')
    expect(config.remoteUser).toBe('node')
  })

  it('devcontainer.json forwards required ports', () => {
    const config = JSON.parse(readFileSync(join(DEVCONTAINER_DIR, 'devcontainer.json'), 'utf-8'))

    const ports = config.forwardPorts as number[]
    expect(ports).toContain(55432) // Postgres
    expect(ports).toContain(12111) // stripe-mock HTTP
    expect(ports).toContain(7233) // Temporal gRPC
  })

  it('devcontainer.json includes required VS Code extensions', () => {
    const config = JSON.parse(readFileSync(join(DEVCONTAINER_DIR, 'devcontainer.json'), 'utf-8'))

    const extensions = config.customizations?.vscode?.extensions as string[]
    expect(extensions).toContain('dbaeumer.vscode-eslint')
    expect(extensions).toContain('esbenp.prettier-vscode')
    expect(extensions).toContain('vitest.explorer')
  })

  it('docker-compose.yml exists and references compose.yml', () => {
    const path = join(DEVCONTAINER_DIR, 'docker-compose.yml')
    expect(existsSync(path), '.devcontainer/docker-compose.yml must exist').toBe(true)

    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('compose.yml')
    expect(content).toContain('DATABASE_URL')
    expect(content).toContain('STRIPE_MOCK_URL')
    expect(content).toContain('TEMPORAL_ADDRESS')
  })

  it('docker-compose.yml app service depends on infrastructure', () => {
    const content = readFileSync(join(DEVCONTAINER_DIR, 'docker-compose.yml'), 'utf-8')

    expect(content).toContain('postgres')
    expect(content).toContain('stripe-mock')
    expect(content).toContain('temporal')
    expect(content).toContain('service_healthy')
  })

  it('Dockerfile exists and sets up Node toolchain', () => {
    const path = join(DEVCONTAINER_DIR, 'Dockerfile')
    expect(existsSync(path), '.devcontainer/Dockerfile must exist').toBe(true)

    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('javascript-node:24')
    expect(content).toContain('corepack enable')
  })

  it('test-devcontainer.sh exists and is executable-ready', () => {
    const path = join(DEVCONTAINER_DIR, 'test-devcontainer.sh')
    expect(existsSync(path), '.devcontainer/test-devcontainer.sh must exist').toBe(true)

    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('#!/usr/bin/env bash')
    expect(content).toContain('set -euo pipefail')
    expect(content).toContain('PASS')
    expect(content).toContain('FAIL')
  })

  it('environment variables use Docker service hostnames, not localhost', () => {
    const content = readFileSync(join(DEVCONTAINER_DIR, 'docker-compose.yml'), 'utf-8')

    // Inside the container, services are reached by hostname, not localhost
    expect(content).toMatch(/DATABASE_URL.*@postgres:/)
    expect(content).toMatch(/STRIPE_MOCK_URL.*stripe-mock:/)
    expect(content).toMatch(/TEMPORAL_ADDRESS.*temporal:/)
  })
})
