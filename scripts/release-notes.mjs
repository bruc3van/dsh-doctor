#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const CHINESE_PATTERN = /[\u3400-\u9FFF]/

export function releaseNotesForTag(source, tag) {
  if (!TAG_PATTERN.test(tag)) throw new Error(`invalid release tag ${JSON.stringify(tag)}`)
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const heading = `## ${tag}`
  const start = lines.findIndex(line => line.trim() === heading)
  if (start === -1) throw new Error(`CHANGELOG.md has no ${heading} section`)
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  const body = lines.slice(start + 1, next === -1 ? undefined : next).join('\n').trim()
  if (body.length === 0) throw new Error(`${heading} has no release notes`)
  if (!CHINESE_PATTERN.test(body)) throw new Error(`${heading} release notes must contain Chinese text`)
  return `${body}\n`
}

function main() {
  const tag = process.argv[2]
  if (tag === undefined) throw new Error('usage: release-notes.mjs <vX.Y.Z>')
  const source = readFileSync(resolve('CHANGELOG.md'), 'utf8')
  process.stdout.write(releaseNotesForTag(source, tag))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
