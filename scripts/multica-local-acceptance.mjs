#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const ISSUE_ID = process.env.MULTICA_ISSUE_ID
if (ISSUE_ID === undefined || ISSUE_ID.trim() === '') {
  console.error('multica-local-acceptance: MULTICA_ISSUE_ID is not set')
  process.exit(2)
}

const FINGERPRINT_KEY = 'local_acceptance_fingerprint'
const LOG_LIMIT_CHARS = 8000

function fail(message) {
  console.error(`multica-local-acceptance: ${message}`)
  process.exit(1)
}

function runMultica(args) {
  return spawnSync('multica', args, {
    encoding: 'utf8',
    env: process.env,
  })
}

function parseArgs(argv) {
  const options = { result: undefined, log: undefined, summary: undefined }
  const positional = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--result') {
      options.result = argv[++index]
      continue
    }
    if (arg === '--log') {
      options.log = argv[++index]
      continue
    }
    if (arg === '--summary') {
      options.summary = argv[++index]
      continue
    }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    fail(`unsupported argument: ${arg}`)
  }
  options.result ??= positional[0]
  if (options.result !== 'passed' && options.result !== 'failed') {
    fail('usage: multica-local-acceptance.mjs --result <passed|failed> [--log <file>] [--summary <text>]')
  }
  return options
}

function readJsonCommand(args) {
  const result = runMultica([...args, '--output', 'json'])
  if (result.status !== 0) {
    fail(`multica ${args.join(' ')} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    fail(`multica ${args.join(' ')} returned invalid JSON`)
  }
}

function fingerprintFor(result, log, summary) {
  const hash = createHash('sha256')
  hash.update(result)
  hash.update('\0')
  hash.update(summary)
  hash.update('\0')
  hash.update(log)
  return hash.digest('hex')
}

function desiredStatus(result) {
  return result === 'passed' ? 'in_review' : 'blocked'
}

function summarizeLog(raw) {
  if (raw.trim() === '') return ''
  const tail = raw.length > LOG_LIMIT_CHARS
    ? `...\n[log truncated to last ${LOG_LIMIT_CHARS} chars]\n${raw.slice(-LOG_LIMIT_CHARS)}`
    : raw
  return `\n<details>\n<summary>日志摘要</summary>\n\n\`\`\`text\n${tail}\n\`\`\`\n</details>\n`
}

async function readLog(logPath) {
  if (logPath === undefined) return ''
  try {
    return await readFile(resolve(process.cwd(), logPath), 'utf8')
  } catch (error) {
    fail(`cannot read log ${logPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeCommentFile(content) {
  const file = resolve(process.cwd(), '.multica', 'acceptance-comment.md')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
  return file
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const issue = readJsonCommand(['issue', 'get', ISSUE_ID])
  const existingFingerprint = issue.metadata?.[FINGERPRINT_KEY]
  const currentStatus = issue.status
  const log = await readLog(options.log)
  const summary = options.summary ?? (options.result === 'passed'
    ? '本地 required_checks 已全部通过。'
    : '本地 required_checks 存在失败项。')
  const fingerprint = fingerprintFor(options.result, log, summary)
  const desired = desiredStatus(options.result)

  if (currentStatus !== desired) {
    const statusResult = runMultica(['issue', 'status', ISSUE_ID, desired, '--no-start'])
    if (statusResult.status !== 0) {
      fail(`multica issue status ${desired} failed: ${statusResult.stderr || statusResult.stdout || `exit ${statusResult.status}`}`)
    }
    console.log(`multica-local-acceptance: issue status -> ${desired}`)
  } else {
    console.log(`multica-local-acceptance: issue status already ${desired}`)
  }

  if (existingFingerprint === fingerprint) {
    console.log('multica-local-acceptance: acceptance comment already posted for this result, skipping')
    return
  }

  const logSection = summarizeLog(log)
  const content = [
    '## 本地验收结果',
    '',
    `- 结果：${options.result === 'passed' ? '通过' : '失败'}`,
    `- 摘要：${summary}`,
    `- 验收指纹：${fingerprint}`,
    '',
    logSection,
  ].join('\n')

  const commentFile = await writeCommentFile(content)
  const commentResult = runMultica(['issue', 'comment', 'add', ISSUE_ID, '--content-file', commentFile])
  if (commentResult.status !== 0) {
    fail(`multica issue comment add failed: ${commentResult.stderr || commentResult.stdout || `exit ${commentResult.status}`}`)
  }

  const metadataResult = runMultica([
    'issue', 'metadata', 'set', ISSUE_ID,
    '--key', FINGERPRINT_KEY,
    '--value', fingerprint,
    '--type', 'string',
  ])
  if (metadataResult.status !== 0) {
    fail(`multica issue metadata set ${FINGERPRINT_KEY} failed: ${metadataResult.stderr || metadataResult.stdout || `exit ${metadataResult.status}`}`)
  }

  console.log(`multica-local-acceptance: posted acceptance comment for ${ISSUE_ID}`)
}

await main()
