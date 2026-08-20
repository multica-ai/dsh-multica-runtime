#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const ISSUE_ID = process.env.MULTICA_ISSUE_ID
if (ISSUE_ID === undefined || ISSUE_ID.trim() === '') {
  console.error('multica-local-progress: MULTICA_ISSUE_ID is not set')
  process.exit(2)
}

function fail(message) {
  console.error(`multica-local-progress: ${message}`)
  process.exit(1)
}

function runMultica(args) {
  return spawnSync('multica', args, {
    encoding: 'utf8',
    env: process.env,
  })
}

function setMetadata(key, value) {
  const result = runMultica([
    'issue', 'metadata', 'set', ISSUE_ID,
    '--key', key,
    '--value', value,
    '--type', 'string',
  ])
  if (result.status !== 0) {
    fail(`multica issue metadata set ${key} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`)
  }
}

async function main() {
  const progressFile = process.argv[2] ?? '.multica/progress.jsonl'
  const absolute = resolve(process.cwd(), progressFile)
  let raw
  try {
    raw = await readFile(absolute, 'utf8')
  } catch (error) {
    fail(`cannot read ${progressFile}: ${error instanceof Error ? error.message : String(error)}`)
  }

  let phase
  let lastArtifact
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry.phase === 'string' && entry.phase.trim() !== '') phase = entry.phase.trim()
    const artifact = entry.last_artifact ?? entry.data?.last_artifact
    if (typeof artifact === 'string' && artifact.trim() !== '') lastArtifact = artifact.trim()
  }

  if (phase === undefined && lastArtifact === undefined) {
    fail(`no phase or last_artifact found in ${progressFile}`)
  }

  if (phase !== undefined) setMetadata('phase', phase)
  if (lastArtifact !== undefined) setMetadata('last_artifact', lastArtifact)

  console.log(`multica-local-progress: wrote ${[
    phase === undefined ? '' : 'phase',
    lastArtifact === undefined ? '' : 'last_artifact',
  ].filter(Boolean).join(', ')} for ${ISSUE_ID}`)
}

await main()
