import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { diagnose, extractStaticRequires, formatReport } from '../src/doctor.mjs'
import { applyRepairs, formatRepairPlan, repairsFromReport } from '../src/repair.mjs'

function json(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function text(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, value)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-doctor-'))
  const home = join(root, 'home')
  const harness = join(root, 'harness')
  const profile = join(home, 'profiles', 'web')
  text(join(harness, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*/*\n  - apps/*\n')
  mkdirSync(join(harness, 'packages'), { recursive: true })
  mkdirSync(join(harness, 'apps'), { recursive: true })
  json(join(harness, 'package.json'), { name: '@deepseek-ai/dsh-root', version: '1.0.0' })
  json(join(profile, 'package.json'), {
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'fixture-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['fixture-plugin'] } },
  })
  return { root, home, harness, profile }
}

function plugin(subject, manifest, client = '') {
  const directory = join(subject.profile, 'node_modules', manifest.name)
  json(join(directory, 'package.json'), manifest)
  if (manifest.dsh?.bundle?.patch) text(join(directory, manifest.dsh.bundle.patch), '[]\n')
  if (manifest.exports?.['./client']) text(join(directory, 'lib', 'client.js'), client)
  return directory
}

test('extractStaticRequires keeps only static package requests', () => {
  assert.deepEqual(extractStaticRequires(`
    require("react")
    require('@scope/pkg/client')
    require('./local.js')
    require(name)
    require('${'${spec}'}')
  `), ['@scope/pkg/client', 'react'])
})

test('extractStaticRequires ignores comments and string contents', () => {
  assert.deepEqual(extractStaticRequires(`
    /* require("commented") */
    const sample = "require('in-a-string')"
    require('real-package')
  `), ['real-package'])
})

test('a healthy profile passes the MVP checks', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin',
    version: '1.0.0',
    exports: { './client': './lib/client.js' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web' },
    },
  }, 'module.exports = require("react")\n')

  const report = diagnose({ home: subject.home, profile: 'web', harnessRoot: subject.harness })
  assert.deepEqual(report.summary, { errors: 0, warnings: 0, info: 0 })
})

test('detects an undeclared legacy client require and removed inject target', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin',
    version: '0.1.0',
    exports: { './client': './lib/client.js' },
    peerDependencies: { '@deepseek-ai/dsh-client-runtime': '^0.1.0' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-runtime'] },
    },
  }, 'module.exports = require("@deepseek-ai/dsh-client-runtime/client")\n')

  const report = diagnose({ home: subject.home, profile: 'web', harnessRoot: subject.harness })
  assert.deepEqual(report.findings.map(item => item.code), [
    'REMOVED_CLIENT_INJECT',
    'UNDECLARED_CLIENT_REQUIRE',
    'LEGACY_HARNESS_PEERS',
    'PROFILE_DEPENDENCY_VERSION_MISMATCH',
  ])
  assert.match(formatReport(report), /Harness may fail to start/)
  assert.match(formatReport(report), /dsh plugin --profile web remove fixture-plugin/)
})

test('an external cannot be supplied by a stale profile fallback package', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin',
    version: '0.1.0',
    exports: { './client': './lib/client.js' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', external: ['@deepseek-ai/dsh-client-runtime/client'] },
    },
  }, 'module.exports = require("@deepseek-ai/dsh-client-runtime/client")\n')
  const stale = join(subject.home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-runtime')
  json(join(stale, 'package.json'), {
    name: '@deepseek-ai/dsh-client-runtime',
    dsh: { client: { platform: 'web' } },
  })

  const report = diagnose({ home: subject.home, profile: 'web', harnessRoot: subject.harness })
  assert.deepEqual(report.findings.map(item => item.code), [
    'CLIENT_EXTERNAL_WITHOUT_SUPPLIER',
    'PROFILE_DEPENDENCY_VERSION_MISMATCH',
  ])
})

test('detects missing dependencies and bundle patches', () => {
  const subject = fixture()
  json(join(subject.profile, 'package.json'), {
    dependencies: { missing: '1.0.0', broken: '1.0.0' },
    dsh: { profile: { bundles: ['broken'] } },
  })
  const directory = join(subject.profile, 'node_modules', 'broken')
  json(join(directory, 'package.json'), {
    name: 'broken',
    version: '1.0.0',
    dsh: { bundle: { patch: './not-there.yml' } },
  })

  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.deepEqual(report.findings.map(item => item.code), [
    'BUNDLE_PATCH_MISSING',
    'DEPENDENCY_NOT_INSTALLED',
  ])
})

test('rejects non-object profile manifests without throwing', () => {
  for (const value of [null, []]) {
    const subject = fixture()
    json(join(subject.profile, 'package.json'), value)
    const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
    assert.deepEqual(report.findings.map(item => item.code), ['INVALID_JSON_OBJECT'])
  }
})

test('matches the Harness dsh.client field contract', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin',
    version: '1.0.0',
    exports: { './client': './lib/client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { immediately: 'yes' } },
  }, 'module.exports = require("react")\n')
  let report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.deepEqual(report.findings.map(item => item.code), ['INVALID_CLIENT_PLATFORM'])

  const manifestFile = join(subject.profile, 'node_modules', 'fixture-plugin', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.dsh.client = { platform: 'web', immediately: 'yes' }
  json(manifestFile, manifest)
  report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.deepEqual(report.findings.map(item => item.code), ['INVALID_CLIENT_IMMEDIATELY'])
})

test('ignores non-web client declarations and rejects browser-only client exports', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'desktop' } },
  })
  let report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.equal(report.summary.errors, 0)

  const manifestFile = join(subject.profile, 'node_modules', 'fixture-plugin', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.exports = { './client': { browser: './lib/client.js' } }
  manifest.dsh.client.platform = 'web'
  json(manifestFile, manifest)
  report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.deepEqual(report.findings.map(item => item.code), ['CLIENT_EXPORT_MISSING'])
})

test('parses profile, home, bundle, settings, and credential documents', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  text(join(subject.profile, 'cordis.patch.yml'), 'not-an-array: true\n')
  text(join(subject.home, 'cordis.patch.yml'), '- id: x\n  config: !!js\n')
  text(join(subject.home, 'settings.yaml'), '- invalid-root\n')
  text(join(subject.home, '.credentials.yaml'), 'version: 2\nsecret: hidden\n')
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.deepEqual(report.findings.map(item => item.code), [
    'INVALID_CREDENTIALS_LAYOUT',
    'INVALID_PATCH_LIST',
    'INVALID_PATCH_YAML',
    'INVALID_SETTINGS_ROOT',
  ])
  assert.doesNotMatch(JSON.stringify(report), /hidden/)
})

test('uses the Harness installation before a profile-local bundle with the same name', () => {
  const subject = fixture()
  const official = join(subject.harness, 'packages', 'bundle', 'fixture-plugin')
  json(join(official, 'package.json'), {
    name: 'fixture-plugin', version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  text(join(official, 'cordis.patch.yml'), '[]\n')
  plugin(subject, { name: 'fixture-plugin', version: '1.0.0' })
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.equal(report.findings.some(item => item.code === 'BUNDLE_DECLARATION_MISSING'), false)
})

test('applies a confirmed JSON repair with a backup and rejects stale previews', () => {
  const subject = fixture()
  json(join(subject.profile, 'package.json'), {
    dependencies: { 'fixture-plugin': '1.0.0' },
    dsh: { profile: { bundles: [] } },
  })
  plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  let report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const actions = repairsFromReport(report)
  assert.deepEqual(actions.map(item => item.id), ['activate-bundle:fixture-plugin'])
  const results = applyRepairs(actions)
  assert.equal(results[0].status, 'applied')
  assert.ok(results[0].backup)
  report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.equal(report.findings.some(item => item.code === 'INSTALLED_BUNDLE_INACTIVE'), false)

  json(join(subject.profile, 'package.json'), {
    dependencies: { 'fixture-plugin': '1.0.0' }, dsh: { profile: { bundles: [] } },
  })
  const stale = repairsFromReport(diagnose({ home: subject.home, harnessRoot: subject.harness }))
  text(join(subject.profile, 'package.json'), `${readFileSync(join(subject.profile, 'package.json'), 'utf8')} `)
  assert.equal(applyRepairs(stale)[0].status, 'failed')
})

test('passes command repair arguments literally without a shell', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-doctor-command-'))
  const output = join(root, 'args.json')
  const action = {
    id: 'command-argv', kind: 'command', risk: 'medium', description: 'argv check',
    command: [
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))',
      output,
      'profile&echo injected',
      '@scope/pkg',
    ],
  }
  assert.match(formatRepairPlan([action]), /profile&echo injected/)
  assert.deepEqual(applyRepairs([action]), [{ id: 'command-argv', status: 'applied' }])
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), ['profile&echo injected', '@scope/pkg'])
})
