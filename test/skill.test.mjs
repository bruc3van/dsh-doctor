import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const skill = readFileSync(new URL('../skills/dsh-plugin-upgrade/SKILL.md', import.meta.url), 'utf8')
const strategy = readFileSync(new URL('../skills/dsh-plugin-upgrade/references/compatibility-strategy.md', import.meta.url), 'utf8')
const sourceInvestigation = readFileSync(new URL('../skills/dsh-plugin-upgrade/references/source-investigation.md', import.meta.url), 'utf8')
const verification = readFileSync(new URL('../skills/dsh-plugin-upgrade/references/verification.md', import.meta.url), 'utf8')

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

test('upgrade skill binds reviewed plans, dependency sync, and actual-source investigation', () => {
  assert.match(skill, /--plan-file <same-reviewed-plan\.json>/)
  assert.match(skill, /--level build --yes --install/)
  assert.match(skill, /source-investigation\.md/)
  assert.match(sourceInvestigation, /Do not assume PATH, a running DSH process, the profile, and the plugin workspace all resolve the same version/)
  assert.match(sourceInvestigation, /git show/)
  assert.match(sourceInvestigation, /additional-version delta/)
})

test('upgrade skill separates catalog rules from the actual 0.1.2 verification target', () => {
  assert.match(skill, /--target-version <actual-0\.1\.2-version>/)
  assert.match(skill, /the catalog's API claims still end at the declared pair/)
  assert.match(sourceInvestigation, /pass that exact version as `--target-version`/)
})

test('upgrade skill stays release-line generic while naming alpha.3 as the current exact target', () => {
  assert.match(skill, /Upgrade a DSH 0\.1\.1 plugin to 0\.1\.2/)
  assert.match(skill, /source ref: `dsh-v0\.1\.1-rc\.2`/)
  assert.match(skill, /target ref: `dsh-v0\.1\.2-alpha\.3`/)
  assert.match(skill, /Keep the skill's product scope at the release-line level/)
})

test('upgrade skill names the Settings Provider migration discovered in a real plugin upgrade', () => {
  assert.match(skill, /settingsNamespace/)
  assert.match(skill, /ctx\.settings\.register/)
  assert.match(skill, /namespace imports/)
  assert.match(skill, /inspect those namespace bindings manually/)
})

test('upgrade skill preserves pnpm release-age policy with exact target exceptions', () => {
  assert.match(verification, /do not disable or weaken the repository-wide supply-chain policy/)
  assert.match(verification, /minimumReleaseAgeExclude/)
  assert.match(verification, /exact `package@version` rows/)
})
