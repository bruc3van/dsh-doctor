import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import crossSpawn from 'cross-spawn'

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function repairsFromReport(report) {
  const unique = new Map()
  for (const item of report.findings) {
    if (item.repair !== undefined && !unique.has(item.repair.id)) unique.set(item.repair.id, item.repair)
  }
  return [...unique.values()].sort((left, right) => {
    if (left.kind === right.kind) return left.id.localeCompare(right.id)
    return left.kind === 'json-edit' ? -1 : 1
  }).map(action => {
    if (action.kind !== 'json-edit') return action
    const text = readFileSync(action.file, 'utf8')
    return { ...action, expectedHash: hash(text) }
  })
}

export function formatRepairPlan(actions, options = {}) {
  const zh = options.language === 'zh'
  const lines = [zh ? '建议执行以下修复：' : 'Proposed repairs:', '']
  actions.forEach((action, index) => {
    const risk = zh ? action.risk === 'low' ? '低风险' : action.risk === 'medium' ? '中风险' : '高风险' : action.risk.toUpperCase()
    lines.push(`${String(index + 1)}. [${risk}] ${localizedDescription(action, zh)}`)
    if (action.kind === 'command') {
      lines.push(`   ${zh ? '命令' : 'Command'}: ${action.command.map(quoteArgument).join(' ')}`)
      if (action.env !== undefined) lines.push(`   ${zh ? '环境' : 'Environment'}: ${Object.entries(action.env).map(([key, value]) => `${key}=${quoteArgument(value)}`).join(' ')}`)
    } else lines.push(`   ${zh ? '文件' : 'File'}: ${action.file}`, `   ${zh ? '备份' : 'Backup'}: ${action.file}.dsh-doctor-<timestamp>.bak`)
    lines.push('')
  })
  const plan = lines.join('\n')
  return options.prompt === false
    ? plan.trimEnd()
    : `${plan}${zh ? '执行这些修复吗？[y/N] ' : 'Apply these repairs? [y/N] '}`
}

function localizedDescription(action, zh) {
  if (!zh) return action.description
  if (action.id.startsWith('update-package:')) return `更新 profile ${action.profile} 中的 ${action.package}。`
  if (action.id.startsWith('install-profile:')) return `安装 profile ${action.profile} 声明的依赖。`
  if (action.id.startsWith('activate-bundle:')) return `把 ${action.operation.name} 加入 dsh.profile.bundles。`
  return action.description
}

function quoteArgument(value) {
  return /^[a-zA-Z0-9_@./:-]+$/.test(value) ? value : JSON.stringify(value)
}

function applyJsonEdit(action) {
  const current = readFileSync(action.file, 'utf8')
  if (hash(current) !== action.expectedHash) {
    throw new Error(`${action.file} changed after the repair preview; diagnose again before applying`)
  }
  const manifest = JSON.parse(current)
  if (action.operation.type !== 'add-bundle') throw new Error(`unsupported JSON repair ${action.operation.type}`)
  if (manifest.dsh === undefined) manifest.dsh = {}
  if (manifest.dsh === null || typeof manifest.dsh !== 'object' || Array.isArray(manifest.dsh)) {
    throw new Error(`${action.file} no longer has a valid dsh object`)
  }
  if (manifest.dsh.profile === undefined) manifest.dsh.profile = {}
  if (manifest.dsh.profile === null || typeof manifest.dsh.profile !== 'object' || Array.isArray(manifest.dsh.profile)) {
    throw new Error(`${action.file} no longer has a valid dsh.profile object`)
  }
  if (manifest.dsh.profile.bundles === undefined) manifest.dsh.profile.bundles = []
  const bundles = manifest.dsh.profile.bundles
  if (!Array.isArray(bundles) || !bundles.every(item => typeof item === 'string')) {
    throw new Error(`${action.file} no longer has a valid dsh.profile.bundles array`)
  }
  if (!bundles.includes(action.operation.name)) bundles.push(action.operation.name)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${action.file}.dsh-doctor-${stamp}.bak`
  copyFileSync(action.file, backup)
  const temporary = join(dirname(action.file), `.dsh-doctor-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: statSync(action.file).mode })
  renameSync(temporary, action.file)
  return { id: action.id, status: 'applied', backup }
}

function limitedOutput(value, limit = 8192) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.length <= limit ? value : `${value.slice(0, limit)}\n... output truncated by DSH Doctor ...`
}

function applyCommand(action, options) {
  const [command, ...args] = action.command
  const captureOutput = options.captureOutput === true
  const result = crossSpawn.sync(command, args, {
    stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...captureOutput ? { encoding: 'utf8' } : {},
    env: action.env === undefined ? process.env : { ...process.env, ...action.env },
  })
  if (result.error != null) throw result.error
  if (result.status !== 0) {
    const reason = result.signal === null
      ? `${command} exited with status ${String(result.status)}`
      : `${command} was terminated by signal ${result.signal}`
    const details = captureOutput ? limitedOutput(result.stderr) ?? limitedOutput(result.stdout) : undefined
    throw new Error(details === undefined ? reason : `${reason}: ${details.trimEnd()}`)
  }
  const stdout = captureOutput ? limitedOutput(result.stdout) : undefined
  const stderr = captureOutput ? limitedOutput(result.stderr) : undefined
  return {
    id: action.id,
    status: 'applied',
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
  }
}

export function applyRepairs(actions, options = {}) {
  const results = []
  for (const action of actions) {
    try {
      results.push(action.kind === 'json-edit' ? applyJsonEdit(action) : applyCommand(action, options))
    } catch (error) {
      results.push({
        id: action.id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      break
    }
  }
  return results
}
