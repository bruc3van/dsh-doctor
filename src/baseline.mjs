import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { atomicWrite, snapshotFile } from './safe-write.mjs'
import { redactSecrets } from './redact.mjs'

export function baselinePath(report, explicit) {
  return explicit === undefined
    ? join(report.context.profileDir, '.dsh-doctor', 'baseline.json')
    : resolve(explicit)
}

export function baselineFromReport(report) {
  const safeReport = redactSecrets(report)
  return {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    profile: report.context.profile,
    home: report.context.home,
    harness: safeReport.context.harness,
    packages: safeReport.context.packages.map(item => ({ name: item.name, version: item.version, compatibility: item.compatibility })),
    configuration: {
      layers: safeReport.context.configuration?.layers ?? [],
      currentDefaultTree: safeReport.context.configuration?.currentDefaultTree ?? [],
      currentEffectiveTree: safeReport.context.configuration?.currentEffectiveTree ?? [],
    },
    findingCodes: report.findings.map(item => item.code),
  }
}

export function createBaseline(report, explicit) {
  const file = baselinePath(report, explicit)
  const snapshot = snapshotFile(file)
  const baseline = baselineFromReport(report)
  const written = atomicWrite(snapshot, `${JSON.stringify(baseline, null, 2)}\n`, { backup: snapshot.exists })
  return { ...written, baseline }
}

function byName(values) {
  return new Map(values.map(item => [item.name, item]))
}

export function compareBaseline(report, explicit) {
  const file = baselinePath(report, explicit)
  if (!existsSync(file)) throw new Error(`baseline does not exist: ${file}`)
  const baseline = JSON.parse(readFileSync(file, 'utf8'))
  if (![1, 2].includes(baseline?.schemaVersion) || !Array.isArray(baseline.packages)) throw new Error(`unsupported baseline document: ${file}`)
  const before = byName(baseline.packages)
  const after = byName(report.context.packages)
  const added = [...after.keys()].filter(name => !before.has(name)).sort()
  const removed = [...before.keys()].filter(name => !after.has(name)).sort()
  const changed = [...after.keys()].filter(name => before.has(name)).flatMap(name => {
    const left = before.get(name)
    const right = after.get(name)
    const fields = ['version', 'compatibility'].filter(field => left[field] !== right[field])
    return fields.length === 0 ? [] : [{ name, fields, before: left, after: right }]
  })
  const oldFindings = new Set(baseline.findingCodes ?? [])
  const currentFindings = new Set(report.findings.map(item => item.code))
  return {
    file,
    baselineCreatedAt: baseline.createdAt,
    harness: { before: baseline.harness, after: report.context.harness },
    packages: { added, removed, changed },
    findings: {
      introduced: [...currentFindings].filter(code => !oldFindings.has(code)).sort(),
      resolved: [...oldFindings].filter(code => !currentFindings.has(code)).sort(),
    },
  }
}
