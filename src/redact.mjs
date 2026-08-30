const REDACTED = '[REDACTED]'

function sensitiveKey(key) {
  const normalized = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  return normalized === 'auth'
    || normalized === 'authorization'
    || normalized === 'bearer'
    || normalized === 'cookie'
    || normalized === 'credentials'
    || normalized === 'credential'
    || normalized === 'key'
    || normalized === 'password'
    || normalized === 'passwd'
    || normalized === 'pwd'
    || normalized === 'sessionid'
    || normalized.endsWith('password')
    || normalized.endsWith('passwd')
    || normalized.endsWith('secret')
    || normalized.endsWith('token')
    || /^(?:api|access|private|public|client|encryption|signing)key$/.test(normalized)
}

const CONFIG_STRUCTURE_KEYS = new Set([
  'id', 'name', 'group', 'disabled', 'origin', 'fields', 'source',
  'replacedSource', 'removedPaths', 'file', 'kind', 'package', 'patchIndex',
])

function redactConfigValues(value) {
  if (Array.isArray(value)) return value.map(redactConfigValues)
  if (value === null || typeof value !== 'object') return value === null ? null : REDACTED
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === 'config') return [key, redactConfigValues(child)]
    if (CONFIG_STRUCTURE_KEYS.has(key)) return [key, redactSecrets(child)]
    return [key, child !== null && typeof child === 'object' ? redactConfigValues(child) : REDACTED]
  }))
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (sensitiveKey(key)) return [key, REDACTED]
    if (key.toLowerCase() === 'config') return [key, redactConfigValues(child)]
    return [key, redactSecrets(child)]
  }))
}
