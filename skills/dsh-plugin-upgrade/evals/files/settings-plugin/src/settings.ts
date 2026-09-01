import { settingsNamespace, SettingsConflictError } from '@deepseek-ai/dsh-settings'

export const namespace = settingsNamespace('focus-timer', {
  type: 'object',
  properties: {
    focusMinutes: { type: 'number', default: 25 },
    breakMinutes: { type: 'number', default: 5 },
  },
})

export function readFocusMinutes(): number {
  const value = namespace.get('focusMinutes')
  return typeof value === 'number' ? value : 25
}

export function describeConflict(error: unknown): string | null {
  if (error instanceof SettingsConflictError) {
    return `settings conflict: ${String(error)}`
  }
  return null
}
