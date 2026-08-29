import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaultDshHome, diagnose, extractStaticRequires, formatReport } from '../src/doctor.mjs'
import { localizedFinding } from '../src/i18n.mjs'
import { applyRepairs, formatRepairOutcome, formatRepairPlan, repairsFromReport } from '../src/repair.mjs'

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

test('extractStaticRequires ignores Node built-ins and member methods', () => {
  assert.deepEqual(extractStaticRequires(`
    require('path')
    require('node:fs')
    loader.require('not-a-static-require')
    require('real-package')
  `), ['real-package'])
})

test('extractStaticRequires keeps unscoped subpaths and ignores regular expression contents', () => {
  assert.deepEqual(extractStaticRequires(`
    const first = /require("inside-regex")/
    const second = /["']/g
    const quotient = total / count
    require('lodash/fp')
    require('real-package')
  `), ['lodash/fp', 'real-package'])
})

test('a healthy profile passes the MVP checks', () => {
  const subject = fixture()
  json(join(subject.harness, 'packages', 'agent', 'agent', 'package.json'), {
    name: '@deepseek-ai/dsh-agent', version: '1.0.0',
  })
  plugin(subject, {
    name: 'fixture-plugin',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-agent': '^1.0.0' },
    exports: { './client': './lib/client.js' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web' },
    },
  }, 'module.exports = require("react")\n')

  const report = diagnose({ home: subject.home, profile: 'web', harnessRoot: subject.harness })
  assert.deepEqual(report.summary, { errors: 0, warnings: 0, info: 0 })
  assert.equal(report.context.packages[0].compatibility, 'compatible')
  assert.deepEqual(report.context.compatibility, {
    incompatible: 0, risk: 0, unknown: 0, compatible: 1,
  })
})

test('classifies an undeclared plugin compatibility contract as unknown without a false warning', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })

  const report = diagnose({ home: subject.home, profile: 'web', harnessRoot: subject.harness })
  assert.deepEqual(report.summary, { errors: 0, warnings: 0, info: 0 })
  assert.equal(report.context.packages[0].compatibility, 'unknown')
  assert.equal(report.context.compatibility.unknown, 1)
  const output = formatReport(report, { language: 'zh' })
  assert.match(output, /插件兼容性: 0 个不兼容，0 个风险，1 个未知，0 个兼容/)
  assert.match(output, /本诊断结果由 @bruc3van\/dsh-doctor 生成，仅供参考。欢迎在 GitHub Star 或反馈问题：https:\/\/github\.com\/bruc3van\/dsh-doctor\n$/)
})

test('does not claim compatibility when an active Harness peer version cannot be resolved', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-agent': '^1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  const shared = join(subject.home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  json(join(shared, 'package.json'), {
    name: '@deepseek-ai/dsh', version: '1.0.0', bin: { dsh: 'lib/bin.js' },
  })
  text(join(shared, 'lib', 'bin.js'), '#!/usr/bin/env node\n')

  const report = diagnose({ home: subject.home, profile: 'web', env: { PATH: '' } })
  assert.deepEqual(report.findings, [])
  assert.equal(report.context.harness.version, '1.0.0')
  assert.equal(report.context.packages[0].compatibility, 'unknown')
  assert.match(formatReport(report), /could not resolve the active version/)
})

test('attributes bundle patch failures and warnings to plugin compatibility', () => {
  const subject = fixture()
  json(join(subject.harness, 'packages', 'agent', 'agent', 'package.json'), {
    name: '@deepseek-ai/dsh-agent', version: '1.0.0',
  })
  const directory = plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-agent': '^1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })

  text(join(directory, 'cordis.patch.yml'), '- id: 42\n  disabled: true\n')
  let report = diagnose({ home: subject.home, profile: 'web', harnessRoot: subject.harness })
  assert.equal(report.findings.find(item => item.code === 'INVALID_PATCH_ID')?.package, 'fixture-plugin')
  assert.equal(report.context.packages[0].compatibility, 'incompatible')

  text(join(directory, 'cordis.patch.yml'), '- id: missing\n  disabled: true\n')
  report = diagnose({ home: subject.home, profile: 'web', harnessRoot: subject.harness })
  assert.equal(report.findings.find(item => item.code === 'PATCH_TARGET_NOT_FOUND')?.package, 'fixture-plugin')
  assert.equal(report.context.packages[0].compatibility, 'risk')
})

test('attributes an invalid plugin dependency map to that plugin', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0',
    peerDependencies: [],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })

  const report = diagnose({ home: subject.home, profile: 'web', harnessRoot: subject.harness })
  assert.equal(report.findings.find(item => item.code === 'INVALID_DEPENDENCY_MAP')?.package, 'fixture-plugin')
  assert.equal(report.context.packages[0].compatibility, 'incompatible')
})

test('detects an undeclared legacy client require and removed inject target', () => {
  const subject = fixture()
  json(join(subject.harness, 'apps', 'cli', 'package.json'), {
    name: '@deepseek-ai/dsh', version: '1.0.0', bin: { dsh: 'lib/bin.js' },
  })
  text(join(subject.harness, 'apps', 'cli', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
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
  assert.equal(report.context.packages[0].compatibility, 'incompatible')
  assert.match(formatReport(report), /DSH may fail to start/)
  assert.equal(report.context.dshCli.available, true)
  const output = formatReport(report)
  assert.match(output, /Plugin problems \(1\)/)
  assert.match(output, /Available commands:/)
  assert.match(output, /plugin --profile web update fixture-plugin/)
  assert.equal(output.match(/plugin --profile web update fixture-plugin/g)?.length, 1)
  assert.match(output, /This diagnostic report was generated by @bruc3van\/dsh-doctor for reference only\.[^\n]+https:\/\/github\.com\/bruc3van\/dsh-doctor\n$/)
  assert.doesNotMatch(output, /run dsh/)
  const update = repairsFromReport(report).find(item => item.id === 'update-package:fixture-plugin')
  assert.equal(update.command[1], join(subject.harness, 'apps', 'cli', 'lib', 'bin.js'))
  assert.deepEqual(update.command.slice(2), ['plugin', '--profile', 'web', 'update', 'fixture-plugin'])
  assert.deepEqual(update.env, { DSH_HOME: subject.home })
})

test('checks removed Harness peers and dependencies for bundle-only plugins after a DSH upgrade', () => {
  const subject = fixture()
  json(join(subject.profile, 'package.json'), {
    dependencies: { 'peer-plugin': '1.0.0', 'dependency-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['peer-plugin', 'dependency-plugin'] } },
  })
  plugin(subject, {
    name: 'peer-plugin', version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-retired-peer': '^1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  plugin(subject, {
    name: 'dependency-plugin', version: '1.0.0',
    dependencies: { '@deepseek-ai/dsh-retired-runtime': '^1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })

  const report = diagnose({ home: subject.home, profile: 'web', harnessRoot: subject.harness })
  assert.deepEqual(report.findings.map(item => item.code), [
    'LEGACY_HARNESS_DEPENDENCIES',
    'LEGACY_HARNESS_PEERS',
  ])
  assert.deepEqual(report.context.packages.map(item => [item.name, item.compatibility]), [
    ['peer-plugin', 'risk'],
    ['dependency-plugin', 'risk'],
  ])
  assert.equal(report.context.compatibility.risk, 2)
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
  assert.deepEqual(report.context.packages.map(item => [item.name, item.installed, item.compatibility]), [
    ['missing', false, 'incompatible'],
    ['broken', true, 'incompatible'],
  ])
  assert.equal(report.context.compatibility.incompatible, 2)
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

test('uses the same JSON plus !!js YAML dialect as Harness patches', () => {
  const subject = fixture()
  const directory = plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  text(join(directory, 'cordis.patch.yml'), '- insert:\n    - id: expression-row\n      config: !!js ""\n')

  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.deepEqual(report.findings, [])
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

test('does not cascade supplier errors from an invalid explicit Harness root', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0',
    exports: { './client': './lib/client.js' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', external: ['client-supplier/client'] },
    },
  }, 'module.exports = require("client-supplier/client")\n')
  json(join(subject.home, 'profiles', 'node_modules', 'client-supplier', 'package.json'), {
    name: 'client-supplier', version: '1.0.0', dsh: { client: { platform: 'web' } },
  })

  const report = diagnose({ home: subject.home, harnessRoot: join(subject.root, 'not-a-harness') })
  assert.deepEqual(report.findings.map(item => item.code), ['INVALID_HARNESS_ROOT'])
})

test('warns without failing when an unrelated workspace manifest is invalid', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  text(join(subject.harness, 'packages', 'unrelated', 'package.json'), 'not json\n')

  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.equal(report.ok, true)
  assert.deepEqual(report.findings.map(item => [item.code, item.severity]), [
    ['INVALID_WORKSPACE_MANIFEST', 'warning'],
  ])
})

test('applies a confirmed JSON repair with a backup and rejects stale previews', () => {
  const subject = fixture()
  json(join(subject.profile, 'package.json'), {
    dependencies: { 'fixture-plugin': '1.0.0' },
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
  assert.deepEqual(JSON.parse(readFileSync(join(subject.profile, 'package.json'), 'utf8')).dsh.profile.bundles, ['fixture-plugin'])
  report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.equal(report.findings.some(item => item.code === 'INSTALLED_BUNDLE_INACTIVE'), false)

  json(join(subject.profile, 'package.json'), {
    dependencies: { 'fixture-plugin': '1.0.0' }, dsh: { profile: { bundles: [] } },
  })
  const stale = repairsFromReport(diagnose({ home: subject.home, harnessRoot: subject.harness }))
  text(join(subject.profile, 'package.json'), `${readFileSync(join(subject.profile, 'package.json'), 'utf8')} `)
  assert.equal(applyRepairs(stale)[0].status, 'failed')
})

test('does not offer a bundle edit that would overwrite malformed profile configuration', () => {
  for (const dsh of ['invalid', { profile: [] }]) {
    const subject = fixture()
    json(join(subject.profile, 'package.json'), {
      dependencies: { 'fixture-plugin': '1.0.0' }, dsh,
    })
    plugin(subject, {
      name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    })

    const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
    assert.equal(repairsFromReport(report).some(item => item.id.startsWith('activate-bundle:')), false)
    assert.equal(report.findings.some(item => item.code === 'INVALID_DSH_CONFIGURATION'
      || item.code === 'INVALID_PROFILE_CONFIGURATION'), true)
  }
})

test('uses the declared dependency name for command repairs after a manifest name mismatch', () => {
  const subject = fixture()
  json(join(subject.harness, 'apps', 'cli', 'package.json'), {
    name: '@deepseek-ai/dsh', version: '1.0.0', bin: { dsh: 'lib/bin.js' },
  })
  text(join(subject.harness, 'apps', 'cli', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  plugin(subject, {
    name: '--danger', version: '1.0.0', dsh: { client: 'invalid' },
  })
  const source = join(subject.profile, 'node_modules', '--danger')
  const target = join(subject.profile, 'node_modules', 'fixture-plugin')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), readFileSync(join(source, 'package.json')))

  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const update = repairsFromReport(report).find(item => item.id === 'update-package:fixture-plugin')
  assert.ok(update)
  assert.deepEqual(update.command.slice(-2), ['update', 'fixture-plugin'])
  assert.equal(update.command.includes('--danger'), false)
})

test('trims DSH_HOME before resolving it', () => {
  assert.equal(defaultDshHome({ DSH_HOME: '  ./fixture-home  ' }), join(process.cwd(), 'fixture-home'))
  assert.equal(diagnose({ home: '~', profile: '..' }).context.home, homedir())
})

test('passes command repair arguments literally without a shell', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-doctor-command-'))
  const output = join(root, 'args.json')
  const action = {
    id: 'command-argv', kind: 'command', risk: 'medium', description: 'argv check',
    command: [
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), home: process.env.DSH_HOME }))',
      output,
      'profile&echo injected',
      '@scope/pkg',
    ],
    env: { DSH_HOME: join(root, 'isolated-home') },
  }
  assert.match(formatRepairPlan([action]), /profile&echo injected/)
  assert.deepEqual(applyRepairs([action]), [{ id: 'command-argv', status: 'applied' }])
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
    args: ['profile&echo injected', '@scope/pkg'],
    home: join(root, 'isolated-home'),
  })
})

test('captures command failures without leaking subprocess output to stdout', () => {
  const action = {
    id: 'command-failure', kind: 'command', risk: 'medium', description: 'failure check',
    command: [process.execPath, '-e', 'process.stdout.write("out"); process.stderr.write("failure detail"); process.exit(3)'],
  }
  const originalWrite = process.stdout.write
  let leaked = ''
  process.stdout.write = value => { leaked += String(value); return true }
  try {
    const results = applyRepairs([
      action,
      { ...action, id: 'not-attempted' },
    ], { captureOutput: true })
    assert.equal(results[0].status, 'failed')
    assert.match(results[0].error, /status 3: failure detail/)
    assert.deepEqual(results[1], { id: 'not-attempted', status: 'skipped' })
    assert.equal(leaked, '')
  } finally {
    process.stdout.write = originalWrite
  }
})

test('times out stalled command repairs and distinguishes a declined plan from no repairs', () => {
  const action = {
    id: 'stalled-command', kind: 'command', risk: 'medium', description: 'timeout check',
    command: [process.execPath, '-e', 'setTimeout(() => {}, 10_000)'],
  }
  const results = applyRepairs([action], { captureOutput: true, commandTimeoutMs: 100 })
  assert.equal(results[0].status, 'failed')
  assert.match(results[0].error, /timed out after 100 ms/)
  assert.equal(formatRepairOutcome([action], [], { declined: true, language: 'en' }), 'Repairs: cancelled by the user.\n')
  assert.equal(formatRepairOutcome([], [], { findingCount: 1, language: 'en' }), 'Repairs: no safe automatic repairs are available; follow the diagnostic suggestions manually.\n')
})

test('localizes the unreadable client bundle repair suggestion', () => {
  const localized = localizedFinding({
    code: 'CLIENT_BUNDLE_UNREADABLE',
    package: 'fixture-plugin',
    message: 'fixture-plugin client bundle cannot be read.',
    suggestion: 'Upgrade fixture-plugin; if no compatible release exists, remove it through the same DSH installation.',
  }, 'zh')
  assert.equal(localized.suggestion, '更新 fixture-plugin；如果没有兼容版本，再通过同一个 DSH 安装移除该插件。')
})

test('formats the same report in Chinese without changing stable finding codes', () => {
  const subject = fixture()
  for (const name of ['agent', 'credentials', 'tools']) {
    json(join(subject.harness, 'packages', name, name, 'package.json'), {
      name: `@deepseek-ai/dsh-${name}`, version: '1.0.0',
    })
  }
  plugin(subject, {
    name: 'fixture-plugin', version: '0.1.0',
    peerDependencies: {
      '@deepseek-ai/dsh-agent': '0.1.0-rc.7',
      '@deepseek-ai/dsh-credentials': '0.1.0-rc.7',
      '@deepseek-ai/dsh-tools': '0.1.0-rc.7',
    },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const output = formatReport(report, { language: 'zh' })
  assert.match(output, /当前使用的 DSH: 1\.0\.0/)
  assert.match(output, /输出语言: 中文/)
  assert.match(output, /声明的兼容范围不包含当前使用的 DSH 版本/)
  assert.doesNotMatch(output, /HARNESS_PEER_VERSION_MISMATCH\] fixture-plugin 声明/)
  assert.match(output, /证据:\n\s+插件要求：0\.1\.0-rc\.7/)
  assert.match(output, /当前 DSH：1\.0\.0/)
  assert.match(output, /涉及 3 个包：@deepseek-ai\/dsh-agent、@deepseek-ai\/dsh-credentials、@deepseek-ai\/dsh-tools/)
  assert.match(output, /汇总：/)
  const mismatch = report.findings.find(item => item.code === 'HARNESS_PEER_VERSION_MISMATCH')
  assert.deepEqual(mismatch.details.peerVersionGroups, [{
    required: '0.1.0-rc.7',
    active: '1.0.0',
    packages: [
      '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-tools',
    ],
  }])
  assert.equal(mismatch.evidence.match(/Active DSH:/g)?.length, 1)
})

test('keeps every package when peer mismatches require multiple version groups', () => {
  const subject = fixture()
  json(join(subject.harness, 'packages', 'agent', 'agent', 'package.json'), {
    name: '@deepseek-ai/dsh-agent', version: '1.0.0',
  })
  json(join(subject.harness, 'packages', 'tools', 'tools', 'package.json'), {
    name: '@deepseek-ai/dsh-tools', version: '2.0.0',
  })
  plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0',
    peerDependencies: {
      '@deepseek-ai/dsh-agent': '0.1.0',
      '@deepseek-ai/dsh-tools': '^1.0.0',
    },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })

  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  const groups = report.findings
    .find(item => item.code === 'HARNESS_PEER_VERSION_MISMATCH').details.peerVersionGroups
  assert.deepEqual(groups, [
    { required: '0.1.0', active: '1.0.0', packages: ['@deepseek-ai/dsh-agent'] },
    { required: '^1.0.0', active: '2.0.0', packages: ['@deepseek-ai/dsh-tools'] },
  ])
  const output = formatReport(report, { language: 'zh' })
  assert.match(output, /第 1 组：[\s\S]*第 2 组：/)
  assert.match(output, /@deepseek-ai\/dsh-agent/)
  assert.match(output, /@deepseek-ai\/dsh-tools/)
})

test('validates direct dependency ranges, Harness peer ranges, and plugin Node engines', () => {
  const subject = fixture()
  json(join(subject.harness, 'packages', 'agent', 'agent', 'package.json'), {
    name: '@deepseek-ai/dsh-agent', version: '1.0.0',
  })
  json(join(subject.profile, 'package.json'), {
    dependencies: { 'fixture-plugin': '^not-a-version' },
    dsh: { profile: { bundles: ['fixture-plugin'] } },
  })
  plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0',
    engines: { node: '<1' },
    peerDependencies: { '@deepseek-ai/dsh-agent': '^not-a-version' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  json(join(subject.harness, 'apps', 'cli', 'package.json'), {
    name: '@deepseek-ai/dsh', version: '1.0.0', bin: { dsh: 'lib/bin.js' },
  })
  text(join(subject.harness, 'apps', 'cli', 'lib', 'bin.js'), '#!/usr/bin/env node\n')

  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.deepEqual(report.findings.map(item => item.code), [
    'INVALID_PROFILE_DEPENDENCY_RANGE',
    'INVALID_HARNESS_PEER_RANGE',
    'PLUGIN_NODE_VERSION_MISMATCH',
  ])
})

test('cross-checks the profile manifest, pnpm lockfile, and installed versions', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  text(join(subject.profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      fixture-plugin:\n        specifier: ^2.0.0\n        version: 2.0.0\n      stale-plugin:\n        specifier: 1.0.0\n        version: 1.0.0\n`)

  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.deepEqual(report.findings.map(item => item.code), [
    'LOCKFILE_DEPENDENCY_STALE',
    'LOCKFILE_INSTALLED_VERSION_MISMATCH',
    'LOCKFILE_SPECIFIER_MISMATCH',
  ])
  assert.deepEqual(report.context.lockfile, {
    file: join(subject.profile, 'pnpm-lock.yaml'), present: true, valid: true,
  })
})

test('accepts a lockfile without a dependencies map when the profile declares none', () => {
  const subject = fixture()
  json(join(subject.profile, 'package.json'), {
    name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: [] } },
  })
  text(join(subject.profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      fixture-dev:\n        specifier: 1.0.0\n        version: 1.0.0\n`)

  const report = diagnose({ home: subject.home, profile: 'web', harnessRoot: subject.harness })
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.context.lockfile, {
    file: join(subject.profile, 'pnpm-lock.yaml'), present: true, valid: true,
  })
})

test('reports DSH runtime version drift and stale profile-local Harness packages', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  json(join(subject.harness, 'apps', 'cli', 'package.json'), {
    name: '@deepseek-ai/dsh', version: '2.0.0', bin: { dsh: 'lib/bin.js' },
  })
  text(join(subject.harness, 'apps', 'cli', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  json(join(subject.profile, 'node_modules', '@deepseek-ai', 'dsh-retired', 'package.json'), {
    name: '@deepseek-ai/dsh-retired', version: '0.1.0',
  })
  json(join(subject.harness, 'packages', 'agent', 'agent', 'package.json'), {
    name: '@deepseek-ai/dsh-agent', version: '2.0.0',
  })
  json(join(subject.profile, 'node_modules', '@deepseek-ai', 'dsh-agent', 'package.json'), {
    name: '@deepseek-ai/dsh-agent', version: '0.5.0',
  })
  json(join(subject.home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-agent', 'package.json'), {
    name: '@deepseek-ai/dsh-agent', version: '1.0.0',
  })

  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.deepEqual(report.findings.map(item => item.code), [
    'DSH_CLI_HARNESS_VERSION_MISMATCH',
    'DUPLICATE_HARNESS_PACKAGE_VERSION',
    'STALE_PROFILE_HARNESS_PACKAGE',
  ])
  const output = formatReport(report, { language: 'zh' })
  assert.match(output, /DSH 环境问题/)
  assert.match(output, /STALE_PROFILE_HARNESS_PACKAGE ×1/)
  assert.match(output, /@deepseek-ai\/dsh-retired/)
})

test('reports a malformed profile-local package scope without throwing', () => {
  const subject = fixture()
  plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  text(join(subject.profile, 'node_modules', '@deepseek-ai'), 'not a directory\n')

  const report = diagnose({ home: subject.home, profile: 'web', harnessRoot: subject.harness })
  assert.deepEqual(report.findings.map(item => item.code), ['PROFILE_HARNESS_SCOPE_UNREADABLE'])
  assert.equal(report.summary.warnings, 1)
})

test('composes patch layers without loading plugins and reports Harness patch warnings', () => {
  const subject = fixture()
  const directory = plugin(subject, {
    name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  text(join(directory, 'cordis.patch.yml'), `- insert:\n    - id: ordinary\n      name: plugin-a\n    - id: group\n      name: group-plugin\n      group: true\n      config: []\n`)
  text(join(subject.profile, 'cordis.patch.yml'), `- id: missing\n  config: {}\n- id: ordinary\n  insert: []\n- id: ordinary\n  name: plugin-b\n  config: {}\n- disabled: true\n`)

  const report = diagnose({ home: subject.home, harnessRoot: subject.harness })
  assert.deepEqual(report.findings.map(item => item.code), [
    'PATCH_ID_REQUIRED',
    'PATCH_NAME_MISMATCH',
    'PATCH_TARGET_NOT_FOUND',
    'PATCH_TARGET_NOT_GROUP',
  ])
})

test('resolves PATH, profile-linked, and explicit DSH CLI installations', () => {
  const subject = fixture()
  const binDir = join(subject.root, 'bin')
  const pathDsh = join(binDir, process.platform === 'win32' ? 'dsh.CMD' : 'dsh')
  text(pathDsh, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
  chmodSync(pathDsh, 0o755)
  let report = diagnose({
    home: subject.home,
    cwd: subject.root,
    env: { PATH: binDir, PATHEXT: '.CMD' },
  })
  assert.equal(report.context.dshCli.source, 'path')
  assert.deepEqual(report.context.dshCli.command, [pathDsh])

  const shared = join(subject.home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  json(join(shared, 'package.json'), {
    name: '@deepseek-ai/dsh', version: '2.0.0', bin: { dsh: 'lib/bin.js' },
  })
  text(join(shared, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  report = diagnose({ home: subject.home, cwd: subject.root, env: { PATH: '' } })
  assert.equal(report.context.dshCli.source, 'profile')
  assert.equal(report.context.dshCli.version, '2.0.0')
  assert.deepEqual(report.context.dshCli.command, [process.execPath, join(realpathSync(shared), 'lib', 'bin.js')])

  report = diagnose({
    home: subject.home,
    cwd: subject.root,
    env: { PATH: '' },
    dshCommand: join(shared, 'lib', 'bin.js'),
  })
  assert.equal(report.context.dshCli.source, 'explicit')
})
