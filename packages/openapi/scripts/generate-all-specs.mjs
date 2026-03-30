#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [repoPath, outputDir] = process.argv.slice(2)
if (!repoPath || !outputDir) {
  console.error('Usage: node generate-all-specs.mjs <repoPath> <outputDir>')
  process.exit(1)
}

const execOpts = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }

let log
try {
  log = execSync(
    `git -C ${repoPath} log --format="%H" -- latest/openapi.spec3.sdk.json openapi/spec3.json`,
    execOpts
  )
} catch (err) {
  console.error(`Fatal: cannot access repo at ${repoPath}: ${err.message}`)
  process.exit(1)
}

const shas = log.trim().split('\n').filter(Boolean)
mkdirSync(outputDir, { recursive: true })

const seen = new Map()
const paths = ['latest/openapi.spec3.sdk.json', 'openapi/spec3.json']

for (const sha of shas) {
  let raw = null
  for (const p of paths) {
    try {
      raw = execSync(`git -C ${repoPath} show ${sha}:${p}`, execOpts)
      break
    } catch {
      // file doesn't exist at this path for this commit
    }
  }
  if (!raw) continue

  let version
  try {
    version = JSON.parse(raw).info?.version
  } catch {
    continue
  }
  if (!version || seen.has(version)) continue

  const filename = `${version}.json`
  writeFileSync(join(outputDir, filename), raw)
  seen.set(version, filename)
  console.error(`Generated ${version}`)
}

const manifest = Object.fromEntries(seen)
writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.error(`Done: ${seen.size} specs from ${shas.length} commits`)
