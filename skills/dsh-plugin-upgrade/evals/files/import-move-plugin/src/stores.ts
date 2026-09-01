import { defineStore, shallowEqual } from '@deepseek-ai/dsh-client-runtime/client'

export interface DraftState {
  text: string
  saving: boolean
}

export function equalDraft(left: DraftState, right: DraftState) {
  return shallowEqual(left, right)
}

export const draftStore = defineStore<DraftState>(() => ({
  text: '',
  saving: false,
}))
