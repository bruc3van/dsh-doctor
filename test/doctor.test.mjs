import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { diagnose, extractStaticRequires, formatReport } from '../src/doctor.mjs'

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
  assert.deepEqual(report.findings.map(item => item.code), ['CLIENT_EXTERNAL_WITHOUT_SUPPLIER'])
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
