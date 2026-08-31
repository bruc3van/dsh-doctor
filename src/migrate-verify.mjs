import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import crossSpawn from 'cross-spawn'
import semver from 'semver'
import { analyzeMigration, publicMigrationReport } from './migrate.mjs'
import { sha256 } from './safe-write.mjs'

function commandResult(command, args, options = {}) {
  const started = Date.now()
  const result = crossSpawn.sync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 10 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return {
    command: [command, ...args],
    status: result.status,
    signal: result.signal,
    durationMs: Date.now() - started,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    passed: result.status === 0,
    ...(result.error ? { error: result.error.message } : {}),
  }
}

function commandEvidence(result) {
  const { stdout, stderr, ...evidence } = result
  return {
    ...evidence,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stdoutHash: sha256(stdout),
    stderrHash: sha256(stderr),
  }
}

function packageManager(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return { command: 'pnpm', install: ['install', '--no-frozen-lockfile', '--ignore-scripts'], lockfile: 'pnpm-lock.yaml', run: script => ['run', script], pack: destination => ['pack', '--pack-destination', destination] }
  if (existsSync(join(root, 'yarn.lock'))) return { command: 'yarn', install: ['install', '--ignore-scripts'], lockfile: 'yarn.lock', run: script => [script], pack: destination => ['pack', '--out', join(destination, 'plugin.tgz')] }
  return { command: 'npm', install: ['install', '--ignore-scripts'], lockfile: 'package-lock.json', run: script => ['run', script], pack: destination => ['pack', '--json', '--pack-destination', destination] }
}

function lockfileHash(root, manager) {
  const file = join(root, manager.lockfile)
  return existsSync(file) ? sha256(readFileSync(file)) : undefined
}

function installedManifestFile(root, name) {
  let current = resolve(root)
  while (true) {
    const file = join(current, 'node_modules', ...name.split('/'), 'package.json')
    if (existsSync(file)) return file
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function installedDependencyEvidence(root, manifest) {
  const requested = new Map()
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (name !== '@deepseek-ai/cordis' && !name.startsWith('@deepseek-ai/dsh-')) continue
      const optional = field === 'optionalDependencies' || (field === 'peerDependencies' && manifest.peerDependenciesMeta?.[name]?.optional === true)
      const declarations = requested.get(name) ?? []
      declarations.push({ field, range, optional })
      requested.set(name, declarations)
    }
  }
  return [...requested].map(([name, declarations]) => {
    const file = installedManifestFile(root, name)
    if (file === undefined) {
      const optional = declarations.every(item => item.optional)
      return { name, declarations, installed: false, optional, passed: optional, ...(optional ? { status: 'optional-missing' } : { error: 'declared dependency is not installed' }) }
    }
    try {
      const installed = JSON.parse(readFileSync(file, 'utf8'))
      const checks = declarations.map(item => {
        const validRange = typeof item.range === 'string' ? semver.validRange(item.range) : null
        return { ...item, passed: validRange !== null && semver.satisfies(installed.version, validRange) }
      })
      return { name, declarations: checks, installed: true, manifestFile: file, installedVersion: installed.version, passed: installed.name === name && checks.every(item => item.passed) }
    } catch (error) {
      return { name, declarations, installed: true, manifestFile: file, passed: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

function discoverDsh(options) {
  if (options.dshCommand) return resolve(options.dshCommand)
  if (options.harnessRoot) {
    const candidate = join(resolve(options.harnessRoot), 'apps', 'cli', 'lib', 'bin.js')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('runtime verification requires --dsh-command or a built --harness-root/apps/cli/lib/bin.js')
}

function dshInvocation(file, args) {
  return /\.(?:mjs|cjs|js)$/i.test(file) ? [process.execPath, [file, ...args]] : [file, args]
}

function tarballFromPack(step, destination) {
  try {
    const parsed = JSON.parse(step.stdout)
    const filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed?.filename
    if (filename) return join(destination, filename)
  } catch {}
  const match = step.stdout.match(/(?:^|\s)([^\s]+\.tgz)(?:\s|$)/m)
  if (match) return resolve(destination, basename(match[1]))
  const fallback = join(destination, 'plugin.tgz')
  return existsSync(fallback) ? fallback : undefined
}

function runtimeProfileEvidence(dshHome, pluginName, dumpOutput) {
  const profileDir = join(dshHome, 'profiles', 'web')
  const manifestFile = join(profileDir, 'package.json')
  const installedManifestFile = join(profileDir, 'node_modules', ...pluginName.split('/'), 'package.json')
  try {
    const profile = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const installed = JSON.parse(readFileSync(installedManifestFile, 'utf8'))
    return {
      profileCreated: true,
      dependencyInstalled: profile.dependencies?.[pluginName] !== undefined,
      bundleActivated: Array.isArray(profile.dsh?.profile?.bundles) && profile.dsh.profile.bundles.includes(pluginName),
      installedPackageResolved: installed.name === pluginName,
      effectiveConfigIncludesPlugin: dumpOutput.includes(pluginName),
    }
  } catch (error) {
    return {
      profileCreated: existsSync(manifestFile),
      dependencyInstalled: false,
      bundleActivated: false,
      installedPackageResolved: false,
      effectiveConfigIncludesPlugin: false,
      evidenceError: error instanceof Error ? error.message : String(error),
    }
  }
}

export function verifyMigration(pluginRoot = process.cwd(), options = {}) {
  const level = options.level ?? 'static'
  if (!['static', 'build', 'runtime'].includes(level)) throw new Error(`unsupported verification level ${level}`)
  if (level !== 'static' && options.yes !== true) throw new Error(`migrate verify --level ${level} executes project commands and requires --yes`)
  if (level !== 'static' && options.install !== true) throw new Error(`migrate verify --level ${level} requires --install to synchronize and verify target dependencies`)
  const analysis = analyzeMigration(pluginRoot, options)
  const result = {
    schemaVersion: 1,
    command: 'migrate verify',
    level,
    plugin: analysis.plugin,
    migration: publicMigrationReport(analysis).migration,
    stages: [{ name: level === 'static' ? 'static' : 'preflight-static', passed: analysis.summary.errors === 0, report: publicMigrationReport(analysis) }],
    status: analysis.summary.errors === 0 ? 'source-migrated' : 'analyzed',
    passed: analysis.summary.errors === 0,
    manualBehaviorVerificationRequired: true,
  }
  if (level === 'static') return result
  if (!result.passed) return result

  const root = analysis.plugin.root
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const manager = packageManager(root)
  const lockfileBefore = lockfileHash(root, manager)
  const installRun = commandResult(manager.command, manager.install, { cwd: root })
  const dependencies = installedDependencyEvidence(root, manifest)
  const dependenciesPassed = installRun.passed && dependencies.every(item => item.passed)
  result.stages.push({
    name: 'dependencies',
    passed: dependenciesPassed,
    packageManager: manager.command,
    command: commandEvidence(installRun),
    lockfile: {
      file: manager.lockfile,
      beforeHash: lockfileBefore,
      afterHash: lockfileHash(root, manager),
    },
    resolved: dependencies,
  })
  result.passed = dependenciesPassed
  if (!result.passed) return result
  const scripts = ['typecheck', 'build', 'test', 'pack:check'].filter(name => typeof manifest.scripts?.[name] === 'string')
  const commandRuns = []
  for (const script of scripts) {
    const run = { name: script, ...commandResult(manager.command, manager.run(script), { cwd: root }) }
    commandRuns.push(run)
    if (!run.passed) break
  }
  const commands = commandRuns.map(commandEvidence)
  const artifactProducerDeclared = scripts.includes('build') || scripts.includes('pack:check')
  const commandsPassed = artifactProducerDeclared && commandRuns.length === scripts.length && commandRuns.every(item => item.passed)
  const buildNote = scripts.length === 0
    ? 'No recognized verification scripts were declared.'
    : !artifactProducerDeclared ? 'Artifact verification requires a build or pack:check script; typecheck/test alone are insufficient.' : undefined
  result.stages.push({ name: 'build', passed: commandsPassed, packageManager: manager.command, commands, note: buildNote })
  const postBuild = analyzeMigration(root, options)
  const postBuildPassed = postBuild.summary.errors === 0
  result.stages.push({ name: 'static-after-build', passed: postBuildPassed, report: publicMigrationReport(postBuild) })
  const buildPassed = commandsPassed && postBuildPassed
  result.passed = buildPassed
  if (result.passed) result.status = 'artifact-verified'
  if (level === 'build' || !result.passed) return result

  const dsh = discoverDsh(options)
  const verificationRoot = mkdtempSync(join(tmpdir(), 'dsh-doctor-migrate-'))
  const packDir = join(verificationRoot, 'pack')
  const dshHome = join(verificationRoot, 'dsh-home')
  mkdirSync(packDir, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  const env = { ...process.env, DSH_HOME: dshHome }
  const [versionCommand, versionArgs] = dshInvocation(dsh, ['--version'])
  const versionRun = commandResult(versionCommand, versionArgs, { cwd: root, env })
  const actualDshVersion = versionRun.stdout.trim()
  const versionPassed = versionRun.passed && actualDshVersion === analysis.migration.to.version
  const pack = commandResult(manager.command, manager.pack(packDir), { cwd: root })
  const tarball = tarballFromPack(pack, packDir)
  const runtimeCommands = []
  if (versionPassed && pack.passed && tarball && existsSync(tarball)) {
    for (const args of [
      ['plugin', '--profile', 'web', 'add', tarball],
      ['--profile', 'web', '--dump-config'],
      ['--profile', 'web', '--help'],
    ]) {
      const [command, commandArgs] = dshInvocation(dsh, args)
      const step = commandResult(command, commandArgs, { cwd: root, env })
      runtimeCommands.push(step)
      if (!step.passed) break
    }
  }
  const profileEvidence = runtimeProfileEvidence(dshHome, analysis.plugin.name, runtimeCommands[1]?.stdout ?? '')
  const evidencePassed = Object.entries(profileEvidence).filter(([key]) => key !== 'evidenceError').every(([, value]) => value === true)
  const runtimePassed = versionPassed && pack.passed && tarball !== undefined && runtimeCommands.length === 3 && runtimeCommands.every(item => item.passed) && evidencePassed
  result.stages.push({
    name: 'runtime',
    passed: runtimePassed,
    dshVersion: { expected: analysis.migration.to.version, actual: actualDshVersion, passed: versionPassed, command: commandEvidence(versionRun) },
    pack: commandEvidence(pack),
    tarball,
    commands: runtimeCommands.map(commandEvidence),
    profileEvidence,
    isolatedDshHome: dshHome,
  })
  result.passed = result.passed && runtimePassed
  if (runtimePassed) result.status = 'runtime-verified'
  if (runtimePassed && !options.keepTemp) {
    rmSync(verificationRoot, { recursive: true, force: true })
    result.stages.at(-1).isolatedDshHome = '(removed after successful verification)'
  } else result.retainedTemporaryDirectory = verificationRoot
  return result
}

export function formatVerification(result, language = 'en') {
  const zh = language === 'zh'
  const lines = [`${zh ? '升级验证' : 'Migration verification'}: ${result.plugin.name}`, `${zh ? '状态' : 'Status'}: ${result.status} (${result.passed ? 'PASS' : 'FAIL'})`]
  for (const stage of result.stages) lines.push(`- ${stage.name}: ${stage.passed ? 'PASS' : 'FAIL'}`)
  if (result.retainedTemporaryDirectory) lines.push(`${zh ? '失败现场保留在' : 'Failure workspace retained at'}: ${result.retainedTemporaryDirectory}`)
  if (result.manualBehaviorVerificationRequired) lines.push(zh ? '仍需人工验证插件的交互、生命周期与业务行为。' : 'Interaction, lifecycle, and business behavior still require manual verification.')
  return `${lines.join('\n')}\n`
}
