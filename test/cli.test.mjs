import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const cli = resolve('src/cli.mjs')

test('CLI reports invalid manifests as structured JSON without a stack trace', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-cli-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), 'null\n')
  const result = spawnSync(process.execPath, [cli, '--home', home, '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.findings.map(item => item.code), ['INVALID_JSON_OBJECT'])
  assert.equal(result.stderr, '')
})

test('CLI uses exit code 2 for arguments and machine-readable runtime failures', () => {
  let result = spawnSync(process.execPath, [cli, '--unknown'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown option/)

  result = spawnSync(process.execPath, [cli, '--yes', '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stdout).operationalError, /--yes requires --fix/)
  assert.equal(result.stderr, '')
})

test('CLI exposes the package version and repair flags', () => {
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0)
  assert.equal(version.stdout, '0.1.1\n')
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
  assert.match(help.stdout, /--fix, --repair/)
  assert.match(help.stdout, /--yes/)
})

test('CLI applies a confirmed repair, creates a backup, and re-diagnoses', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-fix-'))
  const profile = join(home, 'profiles', 'web')
  const plugin = join(profile, 'node_modules', 'fixture-plugin')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    dependencies: { 'fixture-plugin': '1.0.0' },
    dsh: { profile: { bundles: [] } },
  }, null, 2)}\n`)
  writeFileSync(join(plugin, 'package.json'), `${JSON.stringify({
    name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`)
  writeFileSync(join(plugin, 'cordis.patch.yml'), '[]\n')

  const result = spawnSync(process.execPath, [cli, '--home', home, '--fix', '--yes', '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.deepEqual(report.repairs.map(item => item.status), ['applied'])
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['fixture-plugin'])
  assert.equal(readdirSync(profile).filter(name => name.endsWith('.bak')).length, 1)
  assert.match(result.stderr, /Proposed repairs:/)
  assert.doesNotMatch(result.stderr, /Apply these repairs\?/)
})

test('CLI refuses an unconfirmed repair in a non-interactive process', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-fix-prompt-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({ dependencies: { missing: '1.0.0' } })}\n`)
  const isolatedEnv = { ...process.env, PATH: '', Path: '' }
  let result = spawnSync(process.execPath, [cli, '--home', home, '--fix'], { encoding: 'utf8', env: isolatedEnv })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /no working DSH CLI/)

  result = spawnSync(process.execPath, [cli, '--home', home, '--fix', '--dsh-command', process.execPath], { encoding: 'utf8', env: isolatedEnv })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /interactive terminal or explicit --yes/)
})

test('CLI follows the DSH locale preference and supports an explicit language', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-locale-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(home, 'settings.yaml'), 'locale:\n  preference: zh\n')
  writeFileSync(join(profile, 'package.json'), 'null\n')

  let result = spawnSync(process.execPath, [cli, '--home', home], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /输出语言: 中文/)
  assert.match(result.stdout, /必须包含 JSON 对象/)

  result = spawnSync(process.execPath, [cli, '--home', home, '--lang', 'en'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /Output language: English/)
  assert.match(result.stdout, /must contain a JSON object/)

  result = spawnSync(process.execPath, [cli, '--home', home, '--lang', 'zh', '--json'], { encoding: 'utf8' })
  assert.match(JSON.parse(result.stdout).findings[0].message, /must contain a JSON object/)
})
