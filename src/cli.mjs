#!/usr/bin/env node

import { formatReport, diagnose } from './doctor.mjs'
import { applyRepairs, formatRepairPlan, repairsFromReport } from './repair.mjs'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

const HELP = `Usage: dsh-doctor [options]

Diagnostics and confirmed recovery for a DeepSeek Harness profile.

Options:
  --profile <name>       profile to inspect (default: web)
  --home <path>          Harness home (default: $DSH_HOME or ~/.dsh)
  --harness-root <path>  active DeepSeek Harness source checkout
  --json                 print machine-readable JSON
  --fix, --repair        preview and apply available repairs after confirmation
  --yes                  confirm the displayed repair plan non-interactively
  -h, --help             show help
  -v, --version          show version
`

function fail(message) {
  process.stderr.write(`dsh-doctor: ${message}\n\n${HELP}`)
  process.exitCode = 2
}

function valueAfter(args, index, name) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) throw new Error(`${name} needs a value`)
  return value
}

function parse(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--profile') options.profile = valueAfter(args, index++, arg)
    else if (arg === '--home') options.home = valueAfter(args, index++, arg)
    else if (arg === '--harness-root') options.harnessRoot = valueAfter(args, index++, arg)
    else if (arg === '--json') options.json = true
    else if (arg === '--fix' || arg === '--repair') options.fix = true
    else if (arg === '--yes') options.yes = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--version' || arg === '-v') options.version = true
    else throw new Error(`unknown option ${arg}`)
  }
  return options
}

async function main() {
  let options
  try {
    options = parse(process.argv.slice(2))
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return
  }
  if (options.yes && !options.fix) throw new Error('--yes requires --fix')
  if (options.json && options.fix && !options.yes) throw new Error('--json --fix requires --yes because a prompt would corrupt JSON output')
  if (options.help) {
    process.stdout.write(HELP)
  } else if (options.version) {
    const here = dirname(fileURLToPath(import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8'))
    process.stdout.write(`${manifest.version}\n`)
  } else {
    let report = diagnose(options)
    let repairs = []
    if (options.fix) {
      const actions = repairsFromReport(report)
      if (actions.length > 0) {
        let confirmed = options.yes === true
        if (!confirmed) {
          if (!process.stdin.isTTY) throw new Error('--fix needs an interactive terminal or explicit --yes')
          const prompt = formatRepairPlan(actions)
          const reader = createInterface({ input: process.stdin, output: process.stderr })
          const answer = await reader.question(prompt)
          reader.close()
          confirmed = /^y(?:es)?$/i.test(answer.trim())
        }
        if (confirmed) {
          repairs = applyRepairs(actions)
          if (repairs.every(item => item.status === 'applied')) report = diagnose(options)
        }
      }
    }
    const output = options.fix ? { ...report, repairs } : report
    process.stdout.write(options.json
      ? `${JSON.stringify(output, null, 2)}\n`
      : `${formatReport(report, { color: process.stdout.isTTY })}${repairs.length > 0 ? `Repairs: ${JSON.stringify(repairs, null, 2)}\n` : ''}`)
    process.exitCode = repairs.some(item => item.status === 'failed') ? 2 : report.summary.errors > 0 ? 1 : 0
  }
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ version: 1, operationalError: message }, null, 2)}\n`)
  } else {
    process.stderr.write(`dsh-doctor: ${message}\n`)
  }
  process.exitCode = 2
}
