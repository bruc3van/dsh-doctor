import * as settings from '@deepseek-ai/dsh-settings'

// Legacy sync path kept for the timer's "sync every launch" option.
export function legacyNamespace() {
  return settings.settingsNamespace('focus-timer-sync', { type: 'object' })
}
