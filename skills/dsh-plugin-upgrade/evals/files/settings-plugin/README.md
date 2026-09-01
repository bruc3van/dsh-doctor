# dsh-plugin-focus-timer

Test-fixture plugin that mimics a real DSH 0.1.1 plugin using the
`settingsNamespace` factory from `@deepseek-ai/dsh-settings` (removed in DSH
0.1.2-alpha.2), a still-exported symbol from the same declaration
(`SettingsConflictError`), and a namespace import the static analyzer cannot
resolve. Used by the dsh-plugin-upgrade skill evals.
