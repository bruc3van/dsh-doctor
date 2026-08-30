#!/usr/bin/env node

import { formatReport, diagnose, resolveDshHome } from './doctor.mjs'
import { applyRepairs, formatRepairOutcome, formatRepairPlan, repairsFromReport } from './repair.mjs'
import { resolveLanguage } from './i18n.mjs'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

const HELP_EN = `Usage: dsh-doctor [options]

Diagnostics and confirmed recovery for a DeepSeek Harness profile.

Options:
  --profile <name>       profile to inspect (default: web)
  --home <path>          Harness home (default: $DSH_HOME or ~/.dsh)
  --harness-root <path>  active DeepSeek Harness source checkout
  --dsh-command <path>   DSH executable or lib/bin.js used for command repairs
  --lang <auto|zh|en>    output language (default: DSH setting, then system)
  --json                 print machine-readable JSON
  --fix, --repair        preview and apply available repairs after confirmation
  --yes                  confirm the displayed repair plan non-interactively
  -h, --help             show help
  -v, --version          show version
`

const HELP_ZH = `用法：dsh-doctor [选项]

诊断 DeepSeek Harness profile，并在用户确认后实施修复。

选项：
  --profile <名称>       要检查的 profile（默认：web）
  --home <路径>          Harness 主目录（默认：$DSH_HOME 或 ~/.dsh）
  --harness-root <路径>  当前 DeepSeek Harness 源码工作区
  --dsh-command <路径>   命令修复使用的 DSH 可执行文件或 lib/bin.js
  --lang <auto|zh|en>    输出语言（默认：DSH 设置，其次系统语言）
  --json                 输出稳定的机器可读 JSON
  --fix, --repair        展示修复计划，确认后实施
  --yes                  在非交互环境中确认当前修复计划
  -h, --help             显示帮助
  -v, --version          显示版本
`

const help = language => language === 'zh' ? HELP_ZH : HELP_EN

function valueAfter(args, index, name) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) throw new Error(`${name} needs a value`)
  return value
}

function optionValue(arg, name) {
  const prefix = `${name}=`
  if (!arg.startsWith(prefix)) return undefined
  const value = arg.slice(prefix.length)
  if (value === '') throw new Error(`${name} needs a value`)
  return value
}

function parse(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--profile') options.profile = valueAfter(args, index++, arg)
    else if (arg.startsWith('--profile=')) options.profile = optionValue(arg, '--profile')
    else if (arg === '--home') options.home = valueAfter(args, index++, arg)
    else if (arg.startsWith('--home=')) options.home = optionValue(arg, '--home')
    else if (arg === '--harness-root') options.harnessRoot = valueAfter(args, index++, arg)
    else if (arg.startsWith('--harness-root=')) options.harnessRoot = optionValue(arg, '--harness-root')
    else if (arg === '--dsh-command') options.dshCommand = valueAfter(args, index++, arg)
    else if (arg.startsWith('--dsh-command=')) options.dshCommand = optionValue(arg, '--dsh-command')
    else if (arg === '--lang') options.lang = valueAfter(args, index++, arg)
    else if (arg.startsWith('--lang=')) options.lang = optionValue(arg, '--lang')
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
  const options = parse(process.argv.slice(2))
  if (options.version) {
    const here = dirname(fileURLToPath(import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8'))
    process.stdout.write(`${manifest.version}\n`)
    return
  }
  if (options.help) {
    const requested = ['auto', 'zh', 'en'].includes(options.lang) ? options.lang : undefined
    const language = resolveLanguage({
      requested,
      home: resolveDshHome(options.home),
      systemLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    })
    process.stdout.write(help(language))
    return
  }
  const language = resolveLanguage({
    requested: options.lang,
    home: resolveDshHome(options.home),
    systemLocale: Intl.DateTimeFormat().resolvedOptions().locale,
  })
  if (options.yes && !options.fix) throw new Error('--yes requires --fix')
  if (options.json && options.fix && !options.yes) throw new Error('--json --fix requires --yes because a prompt would corrupt JSON output')
  {
    let report = diagnose(options)
    let repairs = []
    let actions = []
    let repairDeclined = false
    if (options.fix) {
      actions = repairsFromReport(report)
      if (actions.length === 0 && report.context.dshCli?.commandRepairNeeded && !report.context.dshCli.available) {
        throw new Error(language === 'zh'
          ? '未找到可用的 DSH CLI，无法执行命令型修复；请使用 --dsh-command 指定当前安装的 dsh 或 lib/bin.js'
          : 'no working DSH CLI was found; pass the active dsh executable or lib/bin.js with --dsh-command')
      }
      if (actions.length > 0) {
        let confirmed = options.yes === true
        const plan = formatRepairPlan(actions, { language, prompt: !confirmed })
        if (confirmed) {
          process.stderr.write(`${plan}\n`)
        } else {
          if (!process.stdin.isTTY) throw new Error('--fix needs an interactive terminal or explicit --yes')
          const reader = createInterface({ input: process.stdin, output: process.stderr })
          const answer = await reader.question(plan)
          reader.close()
          confirmed = /^(?:y(?:es)?|是|确认)$/i.test(answer.trim())
        }
        if (confirmed) {
          repairs = applyRepairs(actions, { captureOutput: options.json })
          if (repairs.every(item => item.status === 'applied')) report = diagnose(options)
        } else repairDeclined = true
      }
    }
    const output = options.fix ? { ...report, repairs } : report
    const noRepairMessage = options.fix && repairs.length === 0 && !options.json
      ? formatRepairOutcome(actions, repairs, {
          declined: repairDeclined,
          findingCount: report.findings.length,
          language,
        })
      : ''
    process.stdout.write(options.json
      ? `${JSON.stringify(output, null, 2)}\n`
      : `${formatReport(report, { color: process.stdout.isTTY, language })}${repairs.length > 0 ? `${language === 'zh' ? '修复结果' : 'Repairs'}: ${JSON.stringify(repairs, null, 2)}\n` : noRepairMessage}`)
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
    process.stderr.write(`dsh-doctor: ${message}\n\n${help('en')}`)
  }
  process.exitCode = 2
}
