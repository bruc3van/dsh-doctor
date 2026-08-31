import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const skill = readFileSync(new URL('../skills/dsh-plugin-upgrade/SKILL.md', import.meta.url), 'utf8')
const strategy = readFileSync(new URL('../skills/dsh-plugin-upgrade/references/compatibility-strategy.md', import.meta.url), 'utf8')
const evals = JSON.parse(readFileSync(new URL('../skills/dsh-plugin-upgrade/evals/evals.json', import.meta.url), 'utf8'))

test('upgrade skill blocks writes until legacy compatibility intent is explicit', () => {
  assert.match(skill, /Should the same upgraded plugin release continue to support DSH 0\.1\.1/)
  assert.match(skill, /stop at `analyzed`/)
  assert.match(skill, /Before any `migrate apply` preview, source or manifest edit, dependency install, build, or runtime command/)
})

test('dual-version guidance requires evidence for both DSH versions', () => {
  assert.match(strategy, /The current migration catalog and `migrate verify` target 0\.1\.2/)
  assert.match(strategy, /isolated profile using the actual 0\.1\.1 Harness CLI/)
  assert.match(strategy, /Claim `dual-version` compatibility only after all required matrix rows pass/)
})

test('skill evals cover an explicit same-release dual-version request', () => {
  const dualVersion = evals.evals.find(item => item.id === 5)
  const targetOnly = evals.evals.find(item => item.id === 6)
  assert.ok(dualVersion)
  assert.match(dualVersion.prompt, /同一个 npm 版本还必须继续支持 0\.1\.1/)
  assert.ok(dualVersion.expectations.some(item => item.includes('DSH 0.1.1 and 0.1.2')))
  assert.ok(targetOnly)
  assert.match(targetOnly.prompt, /只需要支持 DSH 0\.1\.2/)
})
