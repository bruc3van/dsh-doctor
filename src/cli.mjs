#!/usr/bin/env node

import { formatReport, diagnose } from './doctor.mjs'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELP = `Usage: dsh-doctor [options]

Read-only diagnostics for a DeepSeek Harness profile.

Options:
  --profile <name>       profile to inspect (default: web)
  --home <path>          Harness home (default: $DSH_HOME or ~/.dsh)
  --harness-root <path>  active DeepSeek Harness source checkout
  --json                 print machine-readable JSON
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
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--version' || arg === '-v') options.version = true
    else throw new Error(`unknown option ${arg}`)
  }
  return options
}

let options
try {
  options = parse(process.argv.slice(2))
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

if (options !== undefined) {
  if (options.help) {
    process.stdout.write(HELP)
  } else if (options.version) {
    const here = dirname(fileURLToPath(import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8'))
    process.stdout.write(`${manifest.version}\n`)
  } else {
    const report = diagnose(options)
    process.stdout.write(options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatReport(report, { color: process.stdout.isTTY }))
    process.exitCode = report.summary.errors > 0 ? 1 : 0
  }
}
