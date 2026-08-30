import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const catalogRoot = fileURLToPath(new URL('../migrations/', import.meta.url))

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function listMigrations() {
  if (!existsSync(catalogRoot)) return []
  return readdirSync(catalogRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(catalogRoot, entry.name, 'manifest.json')))
    .map(entry => readJson(join(catalogRoot, entry.name, 'manifest.json')))
    .sort((left, right) => left.id.localeCompare(right.id))
}

export function loadMigration(from, to) {
  const manifest = listMigrations().find(item => item.from.ref === from && item.to.ref === to)
  if (manifest === undefined) throw new Error(`unsupported migration ${from} -> ${to}`)
  const root = join(catalogRoot, manifest.id)
  return {
    root,
    manifest,
    packages: readJson(join(root, 'packages.json')),
    symbols: readJson(join(root, 'symbols.json')),
    services: readJson(join(root, 'services.json')),
    configRules: readJson(join(root, 'config-rules.json')),
    behavior: readFileSync(join(root, 'behavior.md'), 'utf8'),
  }
}

function git(harnessRoot, args, description) {
  const result = spawnSync('git', ['-C', harnessRoot, ...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(`Harness ${description} failed${detail === '' ? '' : `: ${detail}`}`)
  }
  return result.stdout.trim()
}

export function verifyHarnessCheckout(catalog, harnessRoot) {
  if (harnessRoot === undefined) return { status: 'catalog-only', exact: false }
  const root = resolve(harnessRoot)
  if (!existsSync(join(root, '.git'))) throw new Error(`not a git checkout: ${harnessRoot}`)
  const fromCommit = git(root, ['rev-list', '-n', '1', catalog.manifest.from.ref], `ref lookup for ${catalog.manifest.from.ref}`)
  const toCommit = git(root, ['rev-list', '-n', '1', catalog.manifest.to.ref], `ref lookup for ${catalog.manifest.to.ref}`)
  if (fromCommit !== catalog.manifest.from.commit || toCommit !== catalog.manifest.to.commit) {
    throw new Error('Harness migration refs do not match the catalog commits')
  }
  const patchPaths = catalog.configRules.profilePatchPaths?.web
  if (!Array.isArray(patchPaths) || patchPaths.length === 0) throw new Error('migration catalog has no authoritative web profile patch paths')
  const entryIds = ref => new Set(git(root, ['grep', '-h', '--', '- id:', ref, '--', ...patchPaths], `web profile entry scan for ${ref}`)
    .split('\n')
    .map(line => /^\s*- id:\s*['"]?([^'"\s#]+)['"]?/.exec(line)?.[1])
    .filter(Boolean))
  return { status: 'verified', exact: true, root, fromCommit, toCommit, fromEntryIds: [...entryIds(catalog.manifest.from.ref)], toEntryIds: [...entryIds(catalog.manifest.to.ref)] }
}
