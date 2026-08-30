import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const cli = resolve('src/cli.mjs')
const packageVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version

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

  result = spawnSync(process.execPath, [cli, '--unknown', '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stdout).operationalError, /unknown option/)
  assert.equal(result.stderr, '')

  result = spawnSync(process.execPath, [cli, '--yes', '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stdout).operationalError, /--yes requires --fix/)
  assert.equal(result.stderr, '')
})

test('CLI rejects recover or baseline mixed with legacy --fix before dispatch', () => {
  let result = spawnSync(process.execPath, [
    cli, 'recover', 'fixture-plugin', '--action', 'remove', '--fix', '--yes', '--json',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stdout).operationalError, /only be used with diagnose/)
  assert.equal(result.stderr, '')

  result = spawnSync(process.execPath, [cli, 'baseline', 'create', '--fix', '--yes'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /only be used with diagnose/)
})

test('CLI exposes the package version and repair flags', () => {
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0)
  assert.equal(version.stdout, `${packageVersion}\n`)
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
  assert.match(help.stdout, /--fix, --repair/)
  assert.match(help.stdout, /--yes/)

  const chineseHelp = spawnSync(process.execPath, [cli, '--lang', 'zh', '--help'], { encoding: 'utf8' })
  assert.equal(chineseHelp.status, 0)
  assert.match(chineseHelp.stdout, /检查选定的 profile/)
  assert.match(chineseHelp.stdout, /输出机器可读 JSON/)
  assert.doesNotMatch(chineseHelp.stdout, /inspect the selected profile|print machine-readable JSON/)

  const helpWithIrrelevantFlags = spawnSync(process.execPath, [cli, '--yes', '--lang', 'fr', '--help'], { encoding: 'utf8' })
  assert.equal(helpWithIrrelevantFlags.status, 0)
  assert.match(helpWithIrrelevantFlags.stdout, /^(?:Usage:|用法：)/)
})

test('CLI recursively redacts secret configuration fields from JSON reports', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-cli-redact-'))
  const profile = join(home, 'profiles', 'web')
  const plugin = join(profile, 'node_modules', 'fixture-plugin')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    dependencies: { 'fixture-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['fixture-plugin'] } },
  })}\n`)
  writeFileSync(join(plugin, 'package.json'), `${JSON.stringify({
    name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  })}\n`)
  writeFileSync(join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: fixture\n      name: fixture-plugin\n      config:\n        accessToken: cli-leak-sentinel\n        label: visible-label\n')
  const result = spawnSync(process.execPath, [cli, '--home', home, '--json'], { encoding: 'utf8' })
  assert.doesNotMatch(result.stdout, /cli-leak-sentinel/)
  assert.match(result.stdout, /\[REDACTED\]/)
  assert.doesNotMatch(result.stdout, /visible-label/)
  assert.match(result.stdout, /"label": "\[REDACTED\]"/)
  JSON.parse(result.stdout)
})

test('CLI omits source excerpts from malformed patch errors', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-cli-yaml-secret-'))
  const profile = join(home, 'profiles', 'web')
  const plugin = join(profile, 'node_modules', 'fixture-plugin')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    dependencies: { 'fixture-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['fixture-plugin'] } },
  })}\n`)
  writeFileSync(join(plugin, 'package.json'), `${JSON.stringify({
    name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  })}\n`)
  writeFileSync(join(plugin, 'cordis.patch.yml'), '- insert: [\n  apiKey: malformed-yaml-leak-sentinel\n')
  const result = spawnSync(process.execPath, [cli, '--home', home, '--json'], { encoding: 'utf8' })
  assert.doesNotMatch(result.stdout, /malformed-yaml-leak-sentinel/)
  const report = JSON.parse(result.stdout)
  assert.match(report.findings.find(item => item.code === 'INVALID_PATCH_YAML').evidence, /line \d+, column \d+/)
})

test('CLI accepts equals-separated option values', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-cli-equals-'))
  const profile = join(home, 'profiles', 'custom')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), 'null\n')

  const result = spawnSync(process.execPath, [
    cli, `--home=${home}`, '--profile=custom', '--lang=en', '--json',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.context.home, home)
  assert.equal(report.context.profile, 'custom')
  assert.deepEqual(report.findings.map(item => item.code), ['INVALID_JSON_OBJECT'])
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

test('CLI explains when findings have no safe automatic repair', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-no-fix-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), 'null\n')

  const result = spawnSync(process.execPath, [cli, '--home', home, '--fix', '--yes', '--lang', 'en'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /no safe automatic repairs are available/)
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

test('CLI keeps command output inside a single JSON document during repairs', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-json-repair-'))
  const profile = join(home, 'profiles', 'web')
  const fakeDsh = join(home, 'fake-dsh.mjs')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({ dependencies: { missing: '1.0.0' } })}\n`)
  writeFileSync(fakeDsh, 'process.stdout.write("fake stdout\\n"); process.stderr.write("fake stderr\\n")\n')

  const result = spawnSync(process.execPath, [
    cli, '--home', home, '--fix', '--yes', '--json', '--dsh-command', fakeDsh,
  ], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.repairs[0].status, 'applied')
  assert.equal(report.repairs[0].stdout, 'fake stdout\n')
  assert.equal(report.repairs[0].stderr, 'fake stderr\n')
})
