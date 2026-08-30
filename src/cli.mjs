#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { formatReport, diagnose, resolveDshHome } from './doctor.mjs'
import { applyRepairs, formatRepairOutcome, formatRepairPlan, repairsFromReport } from './repair.mjs'
import { resolveLanguage } from './i18n.mjs'
import { checkCompatibleVersion } from './registry.mjs'
import { applyPersistentQuarantine, attachUpdateResult, persistentQuarantinePlan, prepareRemovalArtifacts, quarantineDocument, removalPlan, restoreBackup, verifyQuarantine, verifyUpdate, writeQuarantineOverlay } from './recovery.mjs'
import { compareBaseline, createBaseline } from './baseline.mjs'
import { redactSecrets } from './redact.mjs'

const HELP_EN = `Usage:
  dsh-doctor diagnose [options]
  dsh-doctor recover <package> [--action <action>] [options]
  dsh-doctor baseline <create|compare> [options]

Commands:
  diagnose                 inspect the selected profile (default command)
  recover <package>        build and optionally execute one explicit recovery decision
  baseline create|compare  save or compare a pre-upgrade diagnostic snapshot

Options:
  --profile <name>       profile to inspect (default: web)
  --home <path>          Harness home (default: $DSH_HOME or ~/.dsh)
  --harness-root <path>  active DeepSeek Harness source checkout
  --patch <path>         include one CLI overlay in the effective tree (repeatable)
  --dsh-command <path>   DSH executable or lib/bin.js used for commands
  --check-updates        query registry for manifest-declared compatible versions
  --action <action>      check-update, update, quarantine, persist-quarantine, rollback-quarantine, or remove
  --output <path>        quarantine overlay or baseline path
  --backup <path>        backup used by rollback-quarantine
  --verified             assert that a temporary quarantine overlay was tested
  --lang <auto|zh|en>    output language
  --json                 print machine-readable JSON
  --fix, --repair        legacy confirmed repairs (never removes a plugin)
  --yes                  confirm an explicit write or command
  -h, --help             show help
  -v, --version          show version
`

const HELP_ZH = `用法：
  dsh-doctor diagnose [选项]
  dsh-doctor recover <包名> [--action <动作>] [选项]
  dsh-doctor baseline <create|compare> [选项]

命令：
  diagnose                 检查选定的 profile（默认命令）
  recover <包名>           生成并按确认执行一个明确的恢复动作
  baseline create|compare  保存或比较升级前诊断快照

选项：
  --profile <名称>       要检查的 profile（默认：web）
  --home <路径>          Harness home（默认：$DSH_HOME 或 ~/.dsh）
  --harness-root <路径>  当前 DeepSeek Harness 源码工作区
  --patch <路径>         在生效配置树中加入一个 CLI overlay（可重复）
  --dsh-command <路径>   执行动作使用的 DSH 可执行文件或 lib/bin.js
  --check-updates        查询 registry 中由 manifest 声明兼容的版本
  --action <动作>        check-update、update、quarantine、persist-quarantine、rollback-quarantine 或 remove
  --output <路径>        quarantine overlay 或 baseline 路径
  --backup <路径>        rollback-quarantine 使用的备份
  --verified             确认临时 quarantine overlay 已经过测试
  --lang <auto|zh|en>    输出语言
  --json                 输出机器可读 JSON
  --fix, --repair        旧式确认修复（绝不移除插件）
  --yes                  确认一个明确的写入或命令动作
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
  const value = arg.slice(`${name}=`.length)
  if (value === '') throw new Error(`${name} needs a value`)
  return value
}

function parse(args) {
  const options = { command: 'diagnose' }
  let index = 0
  if (['diagnose', 'recover', 'baseline'].includes(args[0])) options.command = args[index++]
  if (options.command === 'recover' && args[index] !== undefined && !args[index].startsWith('-')) options.package = args[index++]
  if (options.command === 'baseline' && args[index] !== undefined && !args[index].startsWith('-')) options.baselineAction = args[index++]
  for (; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--profile') options.profile = valueAfter(args, index++, arg)
    else if (arg.startsWith('--profile=')) options.profile = optionValue(arg, '--profile')
    else if (arg === '--home') options.home = valueAfter(args, index++, arg)
    else if (arg.startsWith('--home=')) options.home = optionValue(arg, '--home')
    else if (arg === '--harness-root') options.harnessRoot = valueAfter(args, index++, arg)
    else if (arg.startsWith('--harness-root=')) options.harnessRoot = optionValue(arg, '--harness-root')
    else if (arg === '--patch') (options.patchFiles ??= []).push(valueAfter(args, index++, arg))
    else if (arg.startsWith('--patch=')) (options.patchFiles ??= []).push(optionValue(arg, '--patch'))
    else if (arg === '--dsh-command') options.dshCommand = valueAfter(args, index++, arg)
    else if (arg.startsWith('--dsh-command=')) options.dshCommand = optionValue(arg, '--dsh-command')
    else if (arg === '--lang') options.lang = valueAfter(args, index++, arg)
    else if (arg.startsWith('--lang=')) options.lang = optionValue(arg, '--lang')
    else if (arg === '--action') options.action = valueAfter(args, index++, arg)
    else if (arg.startsWith('--action=')) options.action = optionValue(arg, '--action')
    else if (arg === '--output') options.output = valueAfter(args, index++, arg)
    else if (arg.startsWith('--output=')) options.output = optionValue(arg, '--output')
    else if (arg === '--backup') options.backup = valueAfter(args, index++, arg)
    else if (arg.startsWith('--backup=')) options.backup = optionValue(arg, '--backup')
    else if (arg === '--check-updates') options.checkUpdates = true
    else if (arg === '--verified') options.verified = true
    else if (arg === '--json') options.json = true
    else if (arg === '--fix' || arg === '--repair') options.fix = true
    else if (arg === '--yes') options.yes = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--version' || arg === '-v') options.version = true
    else throw new Error(`unknown option ${arg}`)
  }
  return options
}

function diagnosisOptions(options) {
  return { profile: options.profile, home: options.home, harnessRoot: options.harnessRoot, dshCommand: options.dshCommand, patchFiles: options.patchFiles }
}

async function checkUpdates(report, selected) {
  const names = selected === undefined ? report.context.pluginDiagnoses.map(item => item.name) : [selected]
  for (const name of names) {
    const diagnosis = report.context.pluginDiagnoses.find(item => item.name === name)
    if (diagnosis === undefined) throw new Error(`package is not a direct profile plugin: ${name}`)
    const result = await checkCompatibleVersion(name, report.context.harness.packages ?? {})
    attachUpdateResult(diagnosis, result, { ...report.context.dshCli, profile: report.context.profile })
  }
}

function print(value, options) {
  const safeValue = typeof value === 'string' ? value : redactSecrets(value)
  process.stdout.write(options.json ? `${JSON.stringify(safeValue, null, 2)}\n` : `${typeof safeValue === 'string' ? safeValue : JSON.stringify(safeValue, null, 2)}\n`)
}

async function legacyFix(options, language) {
  let report = diagnose(diagnosisOptions(options))
  const actions = repairsFromReport(report)
  let repairs = []
  let declined = false
  if (actions.length === 0 && report.context.dshCli?.commandRepairNeeded && !report.context.dshCli.available) {
    throw new Error(language === 'zh' ? '未找到可用的 DSH CLI，无法执行命令型修复；请使用 --dsh-command 指定当前安装的 dsh 或 lib/bin.js' : 'no working DSH CLI was found; pass the active dsh executable or lib/bin.js with --dsh-command')
  }
  if (actions.length > 0) {
    let confirmed = options.yes === true
    const plan = formatRepairPlan(actions, { language, prompt: !confirmed })
    if (confirmed) process.stderr.write(`${plan}\n`)
    else {
      if (!process.stdin.isTTY) throw new Error('--fix needs an interactive terminal or explicit --yes')
      const reader = createInterface({ input: process.stdin, output: process.stderr })
      const answer = await reader.question(plan)
      reader.close()
      confirmed = /^(?:y(?:es)?|是|确认)$/i.test(answer.trim())
    }
    if (confirmed) {
      repairs = applyRepairs(actions, { captureOutput: options.json })
      if (repairs.every(item => item.status === 'applied')) report = diagnose(diagnosisOptions(options))
    } else declined = true
  }
  const output = { ...report, repairs }
  if (options.json) print(output, options)
  else process.stdout.write(`${formatReport(report, { color: process.stdout.isTTY, language })}${repairs.length > 0 ? `${language === 'zh' ? '修复结果' : 'Repairs'}: ${JSON.stringify(repairs, null, 2)}\n` : formatRepairOutcome(actions, repairs, { declined, findingCount: report.findings.length, language })}`)
  process.exitCode = repairs.some(item => item.status === 'failed') ? 2 : report.summary.errors > 0 ? 1 : 0
}

async function runRecover(options) {
  if (options.package === undefined) throw new Error('recover needs a package name')
  const allowed = ['check-update', 'update', 'quarantine', 'persist-quarantine', 'rollback-quarantine', 'remove']
  if (options.action !== undefined && !allowed.includes(options.action)) throw new Error(`unsupported recovery action ${options.action}`)
  let report = diagnose(diagnosisOptions(options))
  const diagnosis = report.context.pluginDiagnoses?.find(item => item.name === options.package)
  if (diagnosis === undefined) throw new Error(`package is not a direct profile plugin: ${options.package}`)
  await checkUpdates(report, options.package)
  const action = options.action
  if (action === undefined || action === 'check-update') return print({ diagnosis }, options)
  if (action === 'quarantine') {
    const patches = quarantineDocument(diagnosis)
    if (options.output === undefined) return print({ action, mode: 'preview', patches, command: ['dsh', '--profile', report.context.profile, '--patch', '<output.yml>'] }, options)
    const result = writeQuarantineOverlay(diagnosis, options.output)
    const verificationReport = diagnose({ ...diagnosisOptions(options), patchFiles: [...(options.patchFiles ?? []), result.file] })
    const verification = verifyQuarantine(verificationReport, patches)
    process.exitCode = verification.allTargetEntriesDisabled ? 0 : 1
    return print({ diagnosis, result, verification: { ...verification, report: verificationReport }, command: ['dsh', '--profile', report.context.profile, '--patch', result.file] }, options)
  }
  if (action === 'persist-quarantine') {
    if (!options.verified) throw new Error('persist-quarantine requires --verified after testing a temporary overlay')
    const plan = persistentQuarantinePlan(diagnosis, report.context.profileDir)
    if (!options.yes) return print({ action, mode: 'preview', file: plan.file, diff: plan.diff }, options)
    const result = applyPersistentQuarantine(plan)
    report = diagnose(diagnosisOptions(options))
    const verification = verifyQuarantine(report, plan.patches)
    process.exitCode = verification.allTargetEntriesDisabled && report.summary.errors === 0 ? 0 : 1
    return print({ action, result, verification: { ...verification, report } }, options)
  }
  if (action === 'rollback-quarantine') {
    if (options.backup === undefined) throw new Error('rollback-quarantine requires --backup')
    const target = join(report.context.profileDir, 'cordis.patch.yml')
    if (!options.yes) return print({ action, mode: 'preview', backup: options.backup, target }, options)
    const result = restoreBackup(options.backup, target)
    report = diagnose(diagnosisOptions(options))
    process.exitCode = report.summary.errors > 0 ? 1 : 0
    return print({ action, result, verification: report }, options)
  }
  if (action === 'remove') {
    const plan = removalPlan(diagnosis, report.context.dshCli, report.context.home, report.context.profile)
    if (!options.yes) return print({ action, mode: 'preview', plan }, options)
    const artifacts = prepareRemovalArtifacts(diagnosis, report)
    const [result] = applyRepairs([plan], { captureOutput: options.json })
    report = diagnose(diagnosisOptions(options))
    const absent = !report.context.packages.some(item => item.name === options.package)
    const entryAbsent = !report.context.configuration?.entries?.some(entry => entry.name === options.package || entry.origin?.package === options.package)
    const bundleAbsent = !report.context.configuration?.layers?.some(layer => layer.package === options.package)
    const targetIds = new Set(plan.impact.hostEntries)
    const referencesAbsent = !report.context.configuration?.patchReferences?.some(reference => targetIds.has(reference.id))
    process.exitCode = result.status === 'failed' ? 2 : absent && entryAbsent && bundleAbsent && referencesAbsent ? (report.summary.errors > 0 ? 1 : 0) : 1
    return print({ action, result, artifacts, verification: { packageAbsent: absent, bundleAbsent, entryAbsent, patchReferencesAbsent: referencesAbsent, report }, rollback: plan.impact.rollback }, options)
  }
  const update = diagnosis.recovery.options.find(item => item.kind === 'update')
  if (update?.availability !== 'available' || update.command.length === 0) throw new Error('no manifest-declared compatible update is available through the active DSH CLI')
  const plan = { id: `update-package:${diagnosis.name}`, kind: 'command', risk: 'medium', description: update.reason, command: update.command, env: { DSH_HOME: report.context.home } }
  if (!options.yes) return print({ action, mode: 'preview', plan }, options)
  const [result] = applyRepairs([plan], { captureOutput: options.json })
  report = diagnose(diagnosisOptions(options))
  const verification = verifyUpdate(report, diagnosis.name, update.impact.candidateVersion)
  process.exitCode = result.status === 'failed' ? 2 : verification.verified ? 0 : 1
  return print({ action, result, verification: { ...verification, report } }, options)
}

async function main() {
  const options = parse(process.argv.slice(2))
  if (options.version) {
    process.stdout.write(`${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}\n`)
    return
  }
  const requestedLanguage = options.help
    ? (['auto', 'zh', 'en'].includes(options.lang) ? options.lang : undefined)
    : options.lang
  const language = resolveLanguage({ requested: requestedLanguage, home: resolveDshHome(options.home), systemLocale: Intl.DateTimeFormat().resolvedOptions().locale })
  if (options.help) return process.stdout.write(help(language))
  if (options.fix && options.command !== 'diagnose') throw new Error('--fix/--repair can only be used with diagnose')
  if (options.yes && !options.fix && options.command === 'diagnose') throw new Error('--yes requires --fix or an explicit recover action')
  if (options.json && options.fix && !options.yes) throw new Error('--json --fix requires --yes because a prompt would corrupt JSON output')
  if (options.fix) return legacyFix(options, language)
  if (options.command === 'recover') return runRecover(options)
  const report = diagnose(diagnosisOptions(options))
  if (options.command === 'baseline') {
    if (!['create', 'compare'].includes(options.baselineAction)) throw new Error('baseline needs create or compare')
    const result = options.baselineAction === 'create' ? createBaseline(report, options.output) : compareBaseline(report, options.output)
    print(result, options)
    process.exitCode = report.summary.errors > 0 ? 1 : 0
    return
  }
  if (options.checkUpdates) await checkUpdates(report)
  print(options.json ? report : formatReport(report, { color: process.stdout.isTTY, language }), options)
  process.exitCode = report.summary.errors > 0 ? 1 : 0
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ version: 2, operationalError: message }, null, 2)}\n`)
  else process.stderr.write(`dsh-doctor: ${message}\n\n${help('en')}`)
  process.exitCode = 2
}
