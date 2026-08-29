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

export function formatRepairPlan(actions) {
  const lines = ['Proposed repairs:', '']
  actions.forEach((action, index) => {
    lines.push(`${String(index + 1)}. [${action.risk.toUpperCase()}] ${action.description}`)
    if (action.kind === 'command') lines.push(`   Command: ${action.command.map(quoteArgument).join(' ')}`)
    else lines.push(`   File: ${action.file}`, `   Backup: ${action.file}.dsh-doctor-<timestamp>.bak`)
    lines.push('')
  })
  return `${lines.join('\n')}Apply these repairs? [y/N] `
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
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error(`${action.file} no longer has a valid dsh.profile.bundles array`)
  if (!bundles.includes(action.operation.name)) bundles.push(action.operation.name)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${action.file}.dsh-doctor-${stamp}.bak`
  copyFileSync(action.file, backup)
  const temporary = join(dirname(action.file), `.dsh-doctor-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: statSync(action.file).mode })
  renameSync(temporary, action.file)
  return { id: action.id, status: 'applied', backup }
}

function applyCommand(action) {
  const [command, ...args] = action.command
  const result = crossSpawn.sync(command, args, { stdio: 'inherit' })
  if (result.error != null) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${String(result.status)}`)
  return { id: action.id, status: 'applied' }
}

export function applyRepairs(actions) {
  const results = []
  for (const action of actions) {
    try {
      results.push(action.kind === 'json-edit' ? applyJsonEdit(action) : applyCommand(action))
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
