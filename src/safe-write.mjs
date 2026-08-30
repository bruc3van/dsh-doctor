import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function snapshotFile(file) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  return { file, exists: existsSync(file), text, hash: sha256(text) }
}

export function atomicWrite(snapshot, nextText, options = {}) {
  const current = existsSync(snapshot.file) ? readFileSync(snapshot.file, 'utf8') : ''
  if (sha256(current) !== snapshot.hash || existsSync(snapshot.file) !== snapshot.exists) {
    throw new Error(`${snapshot.file} changed after the preview; diagnose again before applying`)
  }
  mkdirSync(dirname(snapshot.file), { recursive: true })
  let backup
  let rollbackRecord
  if (snapshot.exists && options.backup !== false) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backup = `${snapshot.file}.dsh-doctor-${stamp}.bak`
    if (existsSync(backup)) backup = `${snapshot.file}.dsh-doctor-${stamp}-${randomBytes(4).toString('hex')}.bak`
    copyFileSync(snapshot.file, backup)
  } else if (!snapshot.exists && options.recordCreation === true) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const nonce = randomBytes(6).toString('hex')
    rollbackRecord = `${snapshot.file}.dsh-doctor-${stamp}-${nonce}.rollback.json`
    const rollbackTemporary = join(dirname(snapshot.file), `.dsh-doctor-${process.pid}-${nonce}.rollback.tmp`)
    writeFileSync(rollbackTemporary, `${JSON.stringify({
      version: 1,
      action: 'delete-created-file',
      target: snapshot.file,
      expectedHash: sha256(nextText),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(rollbackTemporary, rollbackRecord)
  }
  const temporary = join(dirname(snapshot.file), `.dsh-doctor-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  const mode = snapshot.exists ? statSync(snapshot.file).mode : 0o600
  writeFileSync(temporary, nextText, { mode })
  renameSync(temporary, snapshot.file)
  return {
    file: snapshot.file,
    ...(backup === undefined ? {} : { backup }),
    ...(rollbackRecord === undefined ? {} : { rollbackRecord }),
  }
}
