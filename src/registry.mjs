import semver from 'semver'

function harnessPeers(manifest) {
  const peers = manifest?.peerDependencies
  if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) return []
  return Object.entries(peers).filter(([name]) => name === 'cordis' || name.startsWith('@deepseek-ai/'))
}

function declaredCompatible(manifest, activeVersions) {
  const peers = harnessPeers(manifest)
  if (peers.length === 0) return { compatible: false, sufficient: false }
  let resolved = 0
  for (const [name, range] of peers) {
    const active = activeVersions[name]
    if (typeof range !== 'string' || semver.validRange(range) === null || typeof active !== 'string' || semver.valid(active) === null) continue
    resolved += 1
    if (!semver.satisfies(active, range, { includePrerelease: true })) return { compatible: false, sufficient: true }
  }
  return { compatible: resolved === peers.length, sufficient: resolved === peers.length }
}

export async function checkCompatibleVersion(packageName, activeVersions, options = {}) {
  const fetcher = options.fetch ?? globalThis.fetch
  if (typeof fetcher !== 'function') return { status: 'registry-unavailable', error: 'fetch is unavailable' }
  const registry = (options.registry ?? 'https://registry.npmjs.org').replace(/\/$/, '')
  const url = `${registry}/${encodeURIComponent(packageName)}`
  let response
  try {
    response = await fetcher(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
  } catch (error) {
    return { status: 'registry-unavailable', error: error instanceof Error ? error.message : String(error) }
  }
  if (!response.ok) return { status: 'registry-unavailable', httpStatus: response.status }
  let packument
  try {
    packument = await response.json()
  } catch (error) {
    return { status: 'metadata-insufficient', error: error instanceof Error ? error.message : String(error) }
  }
  const versions = packument?.versions
  if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) return { status: 'metadata-insufficient' }
  const published = Object.keys(versions).filter(version => semver.valid(version) !== null).sort(semver.rcompare)
  let sawSufficient = false
  for (const version of published) {
    const result = declaredCompatible(versions[version], activeVersions)
    sawSufficient ||= result.sufficient
    if (result.compatible) {
      return {
        status: 'compatible-candidate-found',
        version,
        package: packageName,
        spec: `${packageName}@${version}`,
        basis: 'manifest-declared',
      }
    }
  }
  return { status: sawSufficient ? 'no-declared-compatible-version' : 'metadata-insufficient' }
}
