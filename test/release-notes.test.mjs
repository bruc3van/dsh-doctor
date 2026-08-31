import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { releaseNotesForTag } from '../scripts/release-notes.mjs'

test('extracts the matching Chinese release section', () => {
  const source = '# 更新日志\n\n## v1.2.3\n\n### 更新\n\n- 中文说明\n\n## v1.2.2\n\n- 旧版本\n'
  assert.equal(releaseNotesForTag(source, 'v1.2.3'), '### 更新\n\n- 中文说明\n')
})

test('rejects missing or non-Chinese release notes', () => {
  assert.throws(() => releaseNotesForTag('## v1.2.2\n\n- 中文\n', 'v1.2.3'), /has no/)
  assert.throws(() => releaseNotesForTag('## v1.2.3\n\n- English only\n', 'v1.2.3'), /must contain Chinese/)
})

test('current package version has matching Chinese release notes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.match(releaseNotesForTag(changelog, `v${manifest.version}`), /主要更新/)
})
