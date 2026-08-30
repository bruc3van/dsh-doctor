import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { diagnose } from '../src/doctor.mjs'
import { checkCompatibleVersion } from '../src/registry.mjs'
import { applyPersistentQuarantine, attachUpdateResult, persistentQuarantinePlan, prepareRemovalArtifacts, quarantineDocument, restoreBackup, verifyQuarantine, verifyUpdate, writeQuarantineOverlay } from '../src/recovery.mjs'
import { compareBaseline, createBaseline } from '../src/baseline.mjs'

function json(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function text(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, value)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-doctor-recovery-'))
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'web')
  const harness = join(root, 'harness')
  text(join(harness, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*/*\n')
  json(join(harness, 'package.json'), { name: 'dsh-root', version: '2.0.0' })
  json(join(harness, 'packages', 'agent', 'agent', 'package.json'), { name: '@deepseek-ai/dsh-agent', version: '2.0.0' })
  json(join(profile, 'package.json'), {
    dependencies: { 'fixture-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['fixture-plugin'] } },
  })
  const plugin = join(profile, 'node_modules', 'fixture-plugin')
  json(join(plugin, 'package.json'), {
    name: 'fixture-plugin', version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-agent': '^1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  text(join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: fixture-row\n      name: ./host\n      config:\n        enabled: true\n        port: 1000\n')
  return { root, home, profile, harness }
}

test('builds default/effective trees with field provenance and recovery decisions', () => {
  const subject = fixture()
  text(join(subject.profile, 'cordis.patch.yml'), '- id: fixture-row\n  name: ./host\n  config:\n    port: 2000\n')
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.equal(report.version, 2)
  assert.equal(report.context.configuration.currentDefaultTree[0].config.enabled, true)
  const effective = report.context.configuration.currentEffectiveTree[0]
  assert.equal(effective.config.port, 2000)
  assert.equal(effective.fields.config.source.kind, 'profile')
  assert.deepEqual(effective.fields.config.removedPaths, ['enabled'])
  assert.ok(report.findings.some(item => item.code === 'CONFIG_REPLACED_BY_HIGHER_LAYER'))
  const diagnosis = report.context.pluginDiagnoses[0]
  assert.equal(diagnosis.cause.type, 'plugin-version')
  assert.equal(diagnosis.update.status, 'not-checked')
  assert.deepEqual(quarantineDocument(diagnosis), [{ id: 'fixture-row', name: './host', disabled: true }])
})

test('does not recommend quarantine for a healthy compatible plugin', () => {
  const subject = fixture()
  const manifestFile = join(subject.profile, 'node_modules', 'fixture-plugin', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.peerDependencies['@deepseek-ai/dsh-agent'] = '^2.0.0'
  json(manifestFile, manifest)
  const diagnosis = diagnose({ home: subject.home, harnessRoot: subject.harness }).context.pluginDiagnoses[0]
  const quarantine = diagnosis.recovery.options.find(item => item.kind === 'quarantine')
  assert.equal(diagnosis.status, 'compatible')
  assert.equal(quarantine.availability, 'available')
  assert.equal(quarantine.recommended, false)
  assert.equal(quarantine.impact.serviceDependents.status, 'unknown')
  assert.equal(diagnosis.recovery.recommended, 'keep')
  attachUpdateResult(diagnosis, {
    status: 'compatible-candidate-found', version: '3.0.0', package: 'fixture-plugin', spec: 'fixture-plugin@3.0.0', basis: 'manifest-declared',
  }, { available: false, profile: 'web' })
  assert.equal(diagnosis.recovery.options.find(item => item.kind === 'update').recommended, false)
  assert.equal(diagnosis.recovery.recommended, 'keep')
})

test('requires review when a plugin statically appears to provide a runtime Service', () => {
  const subject = fixture()
  const manifestFile = join(subject.profile, 'node_modules', 'fixture-plugin', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.main = './lib/index.js'
  json(manifestFile, manifest)
  text(join(subject.profile, 'node_modules', 'fixture-plugin', 'lib', 'index.js'), 'export default function apply(ctx) { ctx.provide("fixtureService", {}) }\n')
  const diagnosis = diagnose({ home: subject.home, harnessRoot: subject.harness }).context.pluginDiagnoses[0]
  const quarantine = diagnosis.recovery.options.find(item => item.kind === 'quarantine')
  assert.equal(quarantine.availability, 'requires-review')
  assert.equal(quarantine.recommended, false)
  assert.equal(quarantine.impact.serviceDependents.provider.status, 'detected')
  assert.ok(quarantine.impact.blockers.some(item => item.includes('runtime Services')))
})

test('includes repeatable CLI overlays after home and profile layers', () => {
  const subject = fixture()
  text(join(subject.profile, 'cordis.patch.yml'), '- id: fixture-row\n  name: ./host\n  disabled: true\n')
  const overlay = join(subject.root, 'run.patch.yml')
  text(overlay, '- id: fixture-row\n  name: ./host\n  disabled: false\n')
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness, patchFiles: [overlay] })
  const effective = report.context.configuration.currentEffectiveTree[0]
  assert.equal(effective.disabled, false)
  assert.equal(effective.fields.disabled.source.kind, 'overlay')
  assert.equal(report.context.configuration.layers.at(-1).file, overlay)
})

test('does not call a same-layer insert followed by a patch incompatible', () => {
  const subject = fixture()
  text(join(subject.profile, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: custom',
    '      name: custom-plugin',
    '- id: custom',
    '  name: custom-plugin',
    '  disabled: true',
    '',
  ].join('\n'))
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.equal(report.findings.some(item => item.code === 'PATCH_INCOMPATIBLE_WITH_CURRENT_DSH'), false)
  assert.equal(report.context.configuration.entries.find(entry => entry.id === 'custom').disabled, true)
})

test('rebuilds effective group children and provenance after complete config replacement', () => {
  const subject = fixture()
  text(join(subject.profile, 'node_modules', 'fixture-plugin', 'cordis.patch.yml'), [
    '- insert:',
    '    - id: fixture-group',
    '      name: fixture-group',
    '      group: true',
    '      config:',
    '        - id: old-child',
    '          name: old-plugin',
    '',
  ].join('\n'))
  text(join(subject.profile, 'cordis.patch.yml'), [
    '- id: fixture-group',
    '  name: fixture-group',
    '  config:',
    '    - id: new-child',
    '      name: new-plugin',
    '',
  ].join('\n'))
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const group = report.context.configuration.currentEffectiveTree.find(entry => entry.id === 'fixture-group')
  assert.deepEqual(group.config.map(entry => entry.id), ['new-child'])
  assert.equal(group.config[0].origin.kind, 'profile')
  assert.equal(report.context.configuration.entries.some(entry => entry.id === 'old-child'), false)
  assert.equal(report.context.configuration.entries.some(entry => entry.id === 'new-child'), true)
})

test('clears ghost children and reports an invalid non-array group config override', () => {
  const subject = fixture()
  text(join(subject.profile, 'node_modules', 'fixture-plugin', 'cordis.patch.yml'), [
    '- insert:',
    '    - id: fixture-group',
    '      name: fixture-group',
    '      group: true',
    '      config:',
    '        - id: old-child',
    '          name: old-plugin',
    '',
  ].join('\n'))
  text(join(subject.profile, 'cordis.patch.yml'), '- id: fixture-group\n  name: fixture-group\n  config: null\n')
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const group = report.context.configuration.currentEffectiveTree.find(entry => entry.id === 'fixture-group')
  assert.equal(group.config, null)
  assert.equal(report.context.configuration.entries.some(entry => entry.id === 'old-child'), false)
  assert.ok(report.findings.some(item => item.code === 'INVALID_GROUP_CONFIG' && item.severity === 'error'))
})

test('authoritative Harness versions never fall back to stale profile packages', () => {
  const subject = fixture()
  const manifestFile = join(subject.profile, 'node_modules', 'fixture-plugin', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.peerDependencies['@deepseek-ai/dsh-removed'] = '^1.0.0'
  json(manifestFile, manifest)
  json(join(subject.profile, 'node_modules', '@deepseek-ai', 'dsh-removed', 'package.json'), {
    name: '@deepseek-ai/dsh-removed', version: '1.5.0',
  })
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.equal(report.context.harness.packages['@deepseek-ai/dsh-removed'], undefined)
  assert.ok(report.findings.some(item => item.code === 'LEGACY_HARNESS_PEERS'))
})

test('registry search selects the highest declared-compatible version instead of latest', async () => {
  const result = await checkCompatibleVersion('fixture-plugin', { '@deepseek-ai/dsh-agent': '2.0.0' }, {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        versions: {
          '3.0.0': { peerDependencies: { '@deepseek-ai/dsh-agent': '^3.0.0' } },
          '2.5.0': { peerDependencies: { '@deepseek-ai/dsh-agent': '^2.0.0' } },
          '2.4.0': { peerDependencies: { '@deepseek-ai/dsh-agent': '^2.0.0' } },
        },
      }),
    }),
  })
  assert.deepEqual(result, {
    status: 'compatible-candidate-found', version: '2.5.0', package: 'fixture-plugin',
    spec: 'fixture-plugin@2.5.0', basis: 'manifest-declared',
  })
})

test('writes a temporary overlay and persists quarantine with backup and exact name assertion', () => {
  const subject = fixture()
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const diagnosis = report.context.pluginDiagnoses[0]
  const overlay = join(subject.root, 'quarantine.yml')
  const temporary = writeQuarantineOverlay(diagnosis, overlay)
  assert.equal(temporary.file, overlay)
  assert.match(readFileSync(overlay, 'utf8'), /name: \.\/host/)
  const isolated = diagnose({ home: subject.home, harnessRoot: subject.harness, patchFiles: [overlay] })
  assert.equal(isolated.context.configuration.entries.find(entry => entry.id === 'fixture-row').disabled, true)

  text(join(subject.profile, 'cordis.patch.yml'), '# keep this comment\n- insert:\n    - id: preserved\n      config: !!js "ctx.value"\n')
  const plan = persistentQuarantinePlan(diagnosis, subject.profile)
  assert.match(plan.after, /disabled: true/)
  assert.match(plan.after, /# keep this comment/)
  assert.match(plan.after, /!!js "ctx.value"/)
  assert.match(plan.diff, /^@@ line /)
  const result = applyPersistentQuarantine(plan)
  assert.ok(existsSync(result.backup))
  assert.equal(readdirSync(subject.profile).filter(name => name.endsWith('.bak')).length, 1)
  const restored = restoreBackup(result.backup, join(subject.profile, 'cordis.patch.yml'))
  assert.ok(existsSync(restored.backup))
  assert.match(readFileSync(join(subject.profile, 'cordis.patch.yml'), 'utf8'), /# keep this comment/)
  assert.doesNotMatch(readFileSync(join(subject.profile, 'cordis.patch.yml'), 'utf8'), /disabled: true/)
})

test('first persistent quarantine records and verifies deletion rollback for a newly created patch', () => {
  const subject = fixture()
  const diagnosis = diagnose({ home: subject.home, harnessRoot: subject.harness }).context.pluginDiagnoses[0]
  const target = join(subject.profile, 'cordis.patch.yml')
  assert.equal(existsSync(target), false)
  const result = applyPersistentQuarantine(persistentQuarantinePlan(diagnosis, subject.profile))
  assert.equal(result.backup, undefined)
  assert.ok(existsSync(result.rollbackRecord))
  assert.ok(existsSync(target))
  const created = readFileSync(target, 'utf8')
  text(target, `${created}# changed after creation\n`)
  assert.throws(() => restoreBackup(result.rollbackRecord, target), /changed after it was created/)
  text(target, created)
  const rolledBack = restoreBackup(result.rollbackRecord, target)
  assert.equal(rolledBack.status, 'deleted')
  assert.equal(existsSync(target), false)
})

test('persistent quarantine appends the final winning override and verifies exact targets', () => {
  const subject = fixture()
  text(join(subject.profile, 'cordis.patch.yml'), [
    '- id: fixture-row',
    '  name: ./host',
    '  disabled: true',
    '- id: fixture-row',
    '  name: ./host',
    '  disabled: false',
    '',
  ].join('\n'))
  let report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const diagnosis = report.context.pluginDiagnoses[0]
  assert.equal(report.context.configuration.entries.find(entry => entry.id === 'fixture-row').disabled, false)
  const plan = persistentQuarantinePlan(diagnosis, subject.profile)
  assert.match(plan.after, /disabled: false[\s\S]*disabled: true/)
  applyPersistentQuarantine(plan)
  report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const verification = verifyQuarantine(report, plan.patches)
  assert.equal(verification.allTargetEntriesDisabled, true)
  assert.deepEqual(verification.targets, [{ id: 'fixture-row', name: './host', matches: 1, disabled: true }])
})

test('persistent quarantine refuses a profile write that cannot outrank home configuration', () => {
  const subject = fixture()
  text(join(subject.home, 'cordis.patch.yml'), '- id: fixture-row\n  name: ./host\n  disabled: false\n')
  const diagnosis = diagnose({ home: subject.home, harnessRoot: subject.harness }).context.pluginDiagnoses[0]
  assert.throws(() => persistentQuarantinePlan(diagnosis, subject.profile), /cannot override higher layer.*home/)
})

test('baseline captures and compares package/version drift', () => {
  const subject = fixture()
  let report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const file = join(subject.root, 'baseline.json')
  createBaseline(report, file)
  const manifestFile = join(subject.profile, 'node_modules', 'fixture-plugin', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.version = '1.1.0'
  json(manifestFile, manifest)
  report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const comparison = compareBaseline(report, file)
  assert.deepEqual(comparison.packages.changed[0].fields, ['version'])
})

test('redacts secret configuration values from JSON output, baselines, and removal snapshots', () => {
  const subject = fixture()
  const patchFile = join(subject.profile, 'node_modules', 'fixture-plugin', 'cordis.patch.yml')
  text(patchFile, [
    '- insert:',
    '    - id: fixture-row',
    '      name: ./host',
    '      config:',
    '        apiKey: json-leak-sentinel',
    '        nested:',
    '          refresh_token: snapshot-leak-sentinel',
    '        visible: safe-value',
    '',
  ].join('\n'))
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const baselineFile = join(subject.root, 'baseline.json')
  createBaseline(report, baselineFile)
  const baselineText = readFileSync(baselineFile, 'utf8')
  assert.doesNotMatch(baselineText, /json-leak-sentinel|snapshot-leak-sentinel/)
  assert.match(baselineText, /\[REDACTED\]/)
  assert.doesNotMatch(baselineText, /safe-value/)
  assert.match(baselineText, /"visible": "\[REDACTED\]"/)

  const artifacts = prepareRemovalArtifacts(report.context.pluginDiagnoses[0], report)
  const snapshotText = readFileSync(artifacts.diagnosis, 'utf8')
  assert.doesNotMatch(snapshotText, /json-leak-sentinel|snapshot-leak-sentinel/)
  assert.match(snapshotText, /\[REDACTED\]/)
})

test('update verification requires the exact candidate and a non-risk target diagnosis', () => {
  const report = {
    summary: { errors: 0 },
    context: { pluginDiagnoses: [{ name: 'fixture-plugin', installedVersion: '2.0.0', status: 'risk' }] },
  }
  assert.equal(verifyUpdate(report, 'fixture-plugin', '2.0.0').verified, false)
  report.context.pluginDiagnoses[0].status = 'compatible'
  assert.equal(verifyUpdate(report, 'fixture-plugin', '2.1.0').verified, false)
  assert.equal(verifyUpdate(report, 'fixture-plugin', '2.0.0').verified, true)
})

test('disabled manual mounts block removal because the official command would leave them dangling', () => {
  const subject = fixture()
  text(join(subject.profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      fixture-plugin:\n        specifier: 1.0.0\n        version: 1.0.0\n")
  text(join(subject.profile, 'cordis.patch.yml'), '- insert:\n    - id: manual-fixture\n      name: fixture-plugin\n      disabled: true\n')
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const remove = report.context.pluginDiagnoses[0].recovery.options.find(item => item.kind === 'remove')
  assert.equal(remove.availability, 'unavailable')
  assert.equal(remove.impact.manualMounts[0].id, 'manual-fixture')
  assert.ok(remove.impact.blockers.includes('manual mounts would remain after package removal'))
})

test('removal is unavailable when diagnosis has no working DSH CLI', () => {
  const subject = fixture()
  text(join(subject.profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      fixture-plugin:\n        specifier: 1.0.0\n        version: 1.0.0\n")
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness, env: { PATH: '', Path: '' } })
  assert.equal(report.context.dshCli.available, false)
  const remove = report.context.pluginDiagnoses[0].recovery.options.find(item => item.kind === 'remove')
  assert.equal(remove.availability, 'unavailable')
  assert.ok(remove.impact.blockers.includes('no working DSH CLI is available'))
})

test('confirmed client contract failures have a confirmed client-contract cause', () => {
  for (const configure of [
    manifest => { manifest.dsh.client = { platform: 'web', immediately: 'yes' } },
    manifest => { manifest.dsh.client = { platform: 'web', external: 'bad' } },
    manifest => { manifest.dsh.client = { platform: 'web', external: ['missing-supplier/client'] } },
  ]) {
    const subject = fixture()
    const manifestFile = join(subject.profile, 'node_modules', 'fixture-plugin', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    manifest.exports = { './client': './lib/client.js' }
    configure(manifest)
    json(manifestFile, manifest)
    text(join(subject.profile, 'node_modules', 'fixture-plugin', 'lib', 'client.js'), '')
    const diagnosis = diagnose({ home: subject.home, harnessRoot: subject.harness }).context.pluginDiagnoses[0]
    assert.equal(diagnosis.status, 'incompatible')
    assert.equal(diagnosis.cause.type, 'client-contract')
    assert.equal(diagnosis.cause.confidence, 'confirmed')
  }
})

test('removal availability includes the quarantine precondition used during execution', () => {
  const subject = fixture()
  json(join(subject.profile, 'package.json'), {
    dependencies: { 'base-plugin': '1.0.0', 'fixture-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['base-plugin', 'fixture-plugin'] } },
  })
  const base = join(subject.profile, 'node_modules', 'base-plugin')
  json(join(base, 'package.json'), { name: 'base-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })
  text(join(base, 'cordis.patch.yml'), '- insert:\n    - id: shared-row\n      name: base-plugin\n')
  text(join(subject.profile, 'node_modules', 'fixture-plugin', 'cordis.patch.yml'), '- id: shared-row\n  name: base-plugin\n  disabled: true\n')
  text(join(subject.profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      base-plugin:\n        specifier: 1.0.0\n        version: 1.0.0\n      fixture-plugin:\n        specifier: 1.0.0\n        version: 1.0.0\n")
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const diagnosis = report.context.pluginDiagnoses.find(item => item.name === 'fixture-plugin')
  const quarantine = diagnosis.recovery.options.find(item => item.kind === 'quarantine')
  const remove = diagnosis.recovery.options.find(item => item.kind === 'remove')
  assert.equal(quarantine.availability, 'requires-review')
  assert.equal(remove.availability, 'unavailable')
  assert.ok(remove.impact.blockers.includes('a complete temporary quarantine cannot be generated'))
})
