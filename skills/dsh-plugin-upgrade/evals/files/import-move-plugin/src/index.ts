import { ClientContext, createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

export interface Note {
  sessionId: SessionId
  text: string
  updatedAt: number
}

export function activate(ctx: ClientContext) {
  const notes = createSnapshotStore<Record<string, Note[]>>({ })

  ctx.on('session:selected', (sessionId: SessionId) => {
    const current = notes.get() ?? { }
    current[sessionId] = current[sessionId] ?? []
    notes.set(current)
  })

  return { notes }
}
