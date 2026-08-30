import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { analyzeMigration, applyMigration, publicMigrationReport } from '../src/migrate.mjs'
import { verifyMigration } from '../src/migrate-verify.mjs'
import { loadMigration, verifyHarnessCheckout } from '../src/migration-catalog.mjs'

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-doctor-migration-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'fixture-plugin',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-client-runtime': '^0.1.1' },
    ...options.manifest,
  }, null, 2)}\n`)
  writeFileSync(join(root, 'src', 'client.ts'), options.source ?? "import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'\nexport type PluginContext = ClientContext\n")
  return root
}

test('migration analysis finds type-only exact and semantic imports without exposing source text', () => {
  const root = fixture({ source: "import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'\nexport type State = [ClientContext, ISessions]\n" })
  const report = analyzeMigration(root)
  assert.equal(report.summary.safeEdits, 2)
  assert.ok(report.findings.some(item => item.code === 'MIG_MOVED_SYMBOL' && item.evidence.symbol === 'ClientContext'))
  assert.ok(report.findings.some(item => item.code === 'MIG_SEMANTIC_API_CHANGE' && item.evidence.symbol === 'ISessions'))
  assert.ok(report.semanticTasks.some(item => item.symbol === 'ISessions'))
  assert.equal(JSON.stringify(publicMigrationReport(report)).includes('export type State'), false)
})

test('migration analysis detects standalone removed-package string literals', () => {
  const root = fixture({ source: "export const legacyPackage = '@deepseek-ai/dsh-client-runtime'\n" })
  const report = analyzeMigration(root)
  assert.ok(report.findings.some(item => item.code === 'MIG_REMOVED_PACKAGE_REFERENCE' && item.evidence.kind === 'string-literal'))
})

test('safe apply splits mixed imports, preserves semantic work, and writes backups', () => {
  const root = fixture({ source: "import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'\nexport type State = [ClientContext, ISessions]\n" })
  const preview = applyMigration(analyzeMigration(root), { safe: true })
  assert.equal(preview.mode, 'preview')
  assert.equal(readFileSync(join(root, 'src', 'client.ts'), 'utf8').includes("from '@deepseek-ai/cordis'"), false)

  const applied = applyMigration(analyzeMigration(root), { safe: true, yes: true })
  assert.equal(applied.mode, 'applied')
  const source = readFileSync(join(root, 'src', 'client.ts'), 'utf8')
  assert.match(source, /import type \{ ISessions \} from '@deepseek-ai\/dsh-client-runtime\/client'/)
  assert.match(source, /import type \{ Context as ClientContext \} from '@deepseek-ai\/cordis'/)
  assert.ok(applied.report.semanticTasks.some(item => item.symbol === 'ISessions'))
  assert.ok(readdirSync(join(root, 'src')).some(name => name.endsWith('.bak')))
  assert.ok(readdirSync(root).some(name => name.endsWith('.bak')))
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-runtime'], '^0.1.1')
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '4.0.2')
})

test('safe apply rejects a file changed after analysis', () => {
  const root = fixture()
  const report = analyzeMigration(root)
  writeFileSync(join(root, 'src', 'client.ts'), `${readFileSync(join(root, 'src', 'client.ts'), 'utf8')}// concurrent edit\n`)
  assert.throws(() => applyMigration(report, { safe: true, yes: true }), /changed after the preview/)
})

test('safe apply retains a removed dependency when unsupported source or config still references it', () => {
  for (const extra of [
    { file: 'Component.vue', text: "<script>import runtime from '@deepseek-ai/dsh-client-runtime/client'</script>\n" },
    { file: 'tsconfig.json', text: '{"compilerOptions":{"types":["@deepseek-ai/dsh-client-runtime"]}}\n' },
  ]) {
    const root = fixture()
    writeFileSync(join(root, extra.file), extra.text)
    const before = analyzeMigration(root)
    assert.ok(before.findings.some(item => item.code === 'MIG_UNSUPPORTED_SOURCE_REFERENCE' && item.location.file === extra.file))
    const applied = applyMigration(before, { safe: true, yes: true })
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-runtime'], '^0.1.1')
    assert.equal(applied.report.verification.passed, false)
  }

  const root = fixture({ manifest: { imports: { '#legacy': '@deepseek-ai/dsh-client-runtime/client' } } })
  applyMigration(analyzeMigration(root), { safe: true, yes: true })
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).peerDependencies['@deepseek-ai/dsh-client-runtime'], '^0.1.1')
})

test('exact-only migration removes the runtime dependency after applying', () => {
  const root = fixture()
  assert.equal(verifyMigration(root, { level: 'static' }).passed, false)
  const applied = applyMigration(analyzeMigration(root), { safe: true, yes: true })
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-runtime'], undefined)
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '4.0.2')
  assert.equal(applied.report.findings.some(item => item.code === 'MIG_REMOVED_PACKAGE_REFERENCE'), false)
})

test('a source comment mentioning the removed package does not block exact dependency cleanup', () => {
  const root = fixture({ source: "// migrated from @deepseek-ai/dsh-client-runtime\nimport type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'\nexport type PluginContext = ClientContext\n" })
  applyMigration(analyzeMigration(root), { safe: true, yes: true })
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).peerDependencies['@deepseek-ai/dsh-client-runtime'], undefined)
})

test('default-plus-named imports are reported but not partially rewritten', () => {
  const root = fixture({ source: "import runtime, { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'\nexport type State = ClientContext\nexport { runtime }\n" })
  const report = analyzeMigration(root)
  assert.equal(report.safeEdits.length, 0)
  assert.ok(report.findings.some(item => item.code === 'MIG_REMOVED_PACKAGE_REFERENCE' && /cannot be rewritten safely/.test(item.message)))
  assert.equal(report.findings.find(item => item.code === 'MIG_MOVED_SYMBOL').autoFix, 'none')
})

test('analysis does not reformat an unchanged manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-doctor-migration-clean-'))
  writeFileSync(join(root, 'package.json'), '{"name":"clean-plugin","version":"1.0.0"}\n')
  writeFileSync(join(root, 'index.js'), 'export const ready = true\n')
  const report = analyzeMigration(root)
  assert.equal(report.safeEdits.length, 0)
})

test('source scanning does not mistake nested src/lib for a top-level build artifact', () => {
  const root = fixture({ source: 'export const ready = true\n', manifest: { peerDependencies: {} } })
  mkdirSync(join(root, 'src', 'lib'), { recursive: true })
  writeFileSync(join(root, 'src', 'lib', 'legacy.ts'), "import '@deepseek-ai/dsh-client-runtime/client'\n")
  const report = analyzeMigration(root)
  assert.ok(report.findings.some(item => item.location.file === 'src/lib/legacy.ts' && item.code === 'MIG_REMOVED_PACKAGE_REFERENCE'))
})

test('safe apply pins target DSH development packages without widening peer contracts', () => {
  const root = fixture({ source: 'export const ready = true\n', manifest: {
    peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.1' },
    devDependencies: { '@deepseek-ai/dsh-settings': '^0.1.1' },
  } })
  applyMigration(analyzeMigration(root), { safe: true, yes: true })
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-settings'], '0.1.2-alpha.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-settings'], '^0.1.1')
})

test('dependency checks reject non-registry DSH ranges and incompatible Cordis ranges', () => {
  const root = fixture({ source: 'export const ready = true\n', manifest: { peerDependencies: {
    '@deepseek-ai/dsh-settings': 'workspace:^',
    '@deepseek-ai/cordis': '^3.0.0',
  } } })
  const report = analyzeMigration(root)
  assert.ok(report.findings.some(item => item.code === 'MIG_INVALID_DEPENDENCY_RANGE' && item.evidence.package === '@deepseek-ai/dsh-settings'))
  assert.ok(report.findings.some(item => item.code === 'MIG_TARGET_PEER_RANGE_MISMATCH' && item.evidence.package === '@deepseek-ai/cordis'))
  assert.equal(report.verification.passed, false)
})

test('stale artifacts fail static verification after source migration', () => {
  const root = fixture({ source: 'export const ready = true\n', manifest: { peerDependencies: {} } })
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'client.js'), "import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'\n")
  const result = verifyMigration(root, { level: 'static' })
  assert.equal(result.passed, false)
  assert.ok(result.stages[0].report.findings.some(item => item.code === 'MIG_SOURCE_ARTIFACT_DRIFT'))
})

test('build verification requires consent and reports output hashes instead of raw command output', () => {
  const root = fixture({ source: 'export const ready = true\n', manifest: { peerDependencies: {}, scripts: { build: 'node -e "console.log(\\\"build-output-sentinel\\\")"' } } })
  assert.throws(() => verifyMigration(root, { level: 'build' }), /requires --yes/)
  const result = verifyMigration(root, { level: 'build', yes: true })
  assert.equal(result.stages.find(item => item.name === 'build').passed, true)
  assert.equal(result.status, 'artifact-verified')
  assert.equal(JSON.stringify(result).includes('build-output-sentinel'), false)
  assert.ok(result.stages.find(item => item.name === 'build').commands[0].stdoutBytes > 0)
})

test('test or typecheck alone cannot claim artifact verification and build failures short-circuit later scripts', () => {
  let root = fixture({ source: 'export const ready = true\n', manifest: { peerDependencies: {}, scripts: { test: 'node -e "process.exit(0)"' } } })
  let result = verifyMigration(root, { level: 'build', yes: true })
  assert.equal(result.passed, false)
  assert.match(result.stages.find(item => item.name === 'build').note, /requires a build or pack:check/)

  root = fixture({ source: 'export const ready = true\n', manifest: { peerDependencies: {}, scripts: {
    build: 'node -e "process.exit(1)"',
    test: 'node -e "process.exit(0)"',
  } } })
  result = verifyMigration(root, { level: 'build', yes: true })
  assert.deepEqual(result.stages.find(item => item.name === 'build').commands.map(item => item.name), ['build'])
})

test('runtime verification packs the real fixture and uses an isolated temporary DSH_HOME', () => {
  const root = fixture({ source: 'export const ready = true\n', manifest: {
    peerDependencies: {},
    scripts: { build: 'node -e "process.exit(0)"' },
    files: ['src', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  } })
  writeFileSync(join(root, 'cordis.patch.yml'), '- insert:\n    - id: fixture-plugin\n      name: fixture-plugin\n')
  const fakeDsh = join(root, 'fake-dsh.mjs')
  writeFileSync(fakeDsh, `import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (!process.env.DSH_HOME?.includes('dsh-doctor-migrate-')) process.exit(3)
if (args[0] === '--version') process.stdout.write('0.1.2-alpha.2\\n')
else if (args[0] === 'plugin') {
  const profile = join(process.env.DSH_HOME, 'profiles', 'web')
  const installed = join(profile, 'node_modules', 'fixture-plugin')
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' }, dsh: { profile: { bundles: ['fixture-plugin'] } } }))
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }))
} else if (args.includes('--dump-config')) process.stdout.write('# fixture-plugin\\n- id: fixture-plugin\\n')
else if (args.includes('--help')) process.stdout.write('fixture help\\n')
else process.exit(4)
`)
  const result = verifyMigration(root, { level: 'runtime', yes: true, dshCommand: fakeDsh })
  assert.equal(result.passed, true)
  assert.equal(result.status, 'runtime-verified')
  assert.equal(result.stages.find(item => item.name === 'runtime').commands.length, 3)
  assert.deepEqual(result.stages.find(item => item.name === 'runtime').profileEvidence, {
    profileCreated: true,
    dependencyInstalled: true,
    bundleActivated: true,
    installedPackageResolved: true,
    effectiveConfigIncludesPlugin: true,
  })
  assert.equal(result.stages.find(item => item.name === 'runtime').isolatedDshHome, '(removed after successful verification)')
  assert.equal(result.retainedTemporaryDirectory, undefined)
})

test('runtime verification rejects a no-op command that only exits successfully', () => {
  const root = fixture({ source: 'export const ready = true\n', manifest: { peerDependencies: {}, scripts: { build: 'node -e "process.exit(0)"' } } })
  const fakeDsh = join(root, 'noop-dsh.mjs')
  writeFileSync(fakeDsh, "if (process.argv.includes('--version')) process.stdout.write('0.1.2-alpha.2\\n')\n")
  const result = verifyMigration(root, { level: 'runtime', yes: true, dshCommand: fakeDsh })
  assert.equal(result.passed, false)
  assert.equal(result.status, 'artifact-verified')
  assert.equal(result.stages.find(item => item.name === 'runtime').profileEvidence.profileCreated, false)
  assert.ok(result.retainedTemporaryDirectory)
  rmSync(result.retainedTemporaryDirectory, { recursive: true, force: true })
})

test('Harness entry scanning uses authoritative web bundle patches and surfaces git scan failures', () => {
  const harness = mkdtempSync(join(tmpdir(), 'dsh-doctor-harness-'))
  const runGit = args => {
    const result = spawnSync('git', ['-C', harness, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  runGit(['init'])
  runGit(['config', 'user.email', 'fixture@example.com'])
  runGit(['config', 'user.name', 'Fixture'])
  for (const path of ['packages/bundle/base', 'packages/bundle/web-app', 'tests/fixtures']) mkdirSync(join(harness, path), { recursive: true })
  writeFileSync(join(harness, 'packages/bundle/base/cordis.patch.yml'), '- insert:\n    - id: old-base\n')
  writeFileSync(join(harness, 'packages/bundle/web-app/cordis.patch.yml'), '- insert:\n    - id: shared-web\n')
  writeFileSync(join(harness, 'tests/fixtures/cordis.yml'), '- insert:\n    - id: only\n')
  runGit(['add', '.'])
  runGit(['commit', '-m', 'from'])
  const fromCommit = runGit(['rev-parse', 'HEAD'])
  runGit(['tag', 'fixture-from'])
  writeFileSync(join(harness, 'packages/bundle/base/cordis.patch.yml'), '- insert:\n    - id: new-base\n')
  runGit(['add', '.'])
  runGit(['commit', '-m', 'to'])
  const toCommit = runGit(['rev-parse', 'HEAD'])
  runGit(['tag', 'fixture-to'])

  const catalog = structuredClone(loadMigration('dsh-v0.1.1-rc.2', 'dsh-v0.1.2-alpha.2'))
  catalog.manifest.from = { ref: 'fixture-from', commit: fromCommit }
  catalog.manifest.to = { ref: 'fixture-to', commit: toCommit, version: '0.1.2-alpha.2' }
  const evidence = verifyHarnessCheckout(catalog, harness)
  assert.ok(evidence.fromEntryIds.includes('old-base'))
  assert.ok(evidence.toEntryIds.includes('new-base'))
  assert.equal(evidence.toEntryIds.includes('only'), false)

  catalog.configRules.profilePatchPaths.web = ['missing.patch.yml']
  assert.throws(() => verifyHarnessCheckout(catalog, harness), /web profile entry scan.*failed/)
})

test('CLI lists catalogs and reports migration failures as one JSON document', () => {
  const cli = resolve('src/cli.mjs')
  let result = spawnSync(process.execPath, [cli, 'migrations', 'list', '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(JSON.parse(result.stdout).migrations[0].to.ref, 'dsh-v0.1.2-alpha.2')

  const root = fixture({ source: "import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'\n" })
  result = spawnSync(process.execPath, [cli, 'migrate', 'analyze', root, '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.ok(report.findings.some(item => item.code === 'MIG_SEMANTIC_API_CHANGE'))
  assert.equal(result.stderr, '')

  result = spawnSync(process.execPath, [cli, 'migrate', 'apply', root, '--safe', '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.equal(JSON.parse(result.stdout).mode, 'preview')
  assert.equal(readFileSync(join(root, 'src', 'client.ts'), 'utf8').includes("from '@deepseek-ai/dsh-api-session-controller/client'"), false)

  result = spawnSync(process.execPath, [cli, 'migrate', 'apply', '--safe', '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stdout).operationalError, /explicit plugin root/)
})
