import type { Commit, CommitEdit, RewritePlan, TodoAction, TodoItem } from './types'

export interface DraftSequence {
  branch: string
  base: string | null
  tip: string
  /** Oldest first. */
  todo: TodoItem[]
}

export interface Draft {
  edits: Record<string, CommitEdit>
  sequence: DraftSequence | null
}

export const EMPTY_DRAFT: Draft = { edits: {}, sequence: null }

export type RowDraftState = 'edited' | 'moved' | 'dropped' | 'squashed' | 'fixup'

export interface DisplayCommit extends Commit {
  draftStates: RowDraftState[]
}

/** The first-parent run ending at `tip`, oldest first, stopping below at a merge commit or the root. */
export function linearChain(commits: Commit[], tip: string): { base: string | null; chain: string[] } | null {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]))
  const chain: string[] = []
  let current = bySha.get(tip)
  if (!current) return null
  let base: string | null = null
  while (current) {
    if (current.parents.length > 1) {
      base = current.sha
      break
    }
    chain.unshift(current.sha)
    base = current.parents[0] ?? null
    current = base ? bySha.get(base) : undefined
  }
  return chain.length ? { base, chain } : null
}

export function startSequence(commits: Commit[], branch: string, tip: string): DraftSequence | null {
  const run = linearChain(commits, tip)
  if (!run) return null
  return {
    branch,
    base: run.base,
    tip,
    todo: run.chain.map((sha) => ({ sha, action: 'pick' as TodoAction }))
  }
}

function originalOrder(commits: Commit[], sequence: DraftSequence): string[] {
  return linearChain(commits, sequence.tip)?.chain ?? []
}

export function isSequenceChanged(commits: Commit[], sequence: DraftSequence | null): boolean {
  if (!sequence) return false
  const original = originalOrder(commits, sequence)
  return sequence.todo.some((item, index) => item.action !== 'pick' || item.sha !== original[index])
}

/** Moves `sha` right above or below `target` in the visual, newest-first list. */
export function moveInSequence(sequence: DraftSequence, sha: string, target: string, position: 'above' | 'below'): DraftSequence {
  if (sha === target) return sequence
  const moving = sequence.todo.find((item) => item.sha === sha)
  if (!moving) return sequence
  const rest = sequence.todo.filter((item) => item.sha !== sha)
  const index = rest.findIndex((item) => item.sha === target)
  if (index === -1) return sequence
  // Todo is oldest first, so "above" in the list means later in the todo.
  rest.splice(position === 'above' ? index + 1 : index, 0, { ...moving, action: moving.action === 'drop' ? 'drop' : 'pick' })
  return normalizeSequence({ ...sequence, todo: rest })
}

/** Melds `sha` into `target`: it moves directly above it and stops being its own commit. */
export function squashInSequence(sequence: DraftSequence, sha: string, target: string, action: 'squash' | 'fixup'): DraftSequence {
  if (sha === target) return sequence
  const moved = moveInSequence(sequence, sha, target, 'above')
  return normalizeSequence({
    ...moved,
    todo: moved.todo.map((item) => (item.sha === sha ? { ...item, action } : item))
  })
}

export function setAction(sequence: DraftSequence, sha: string, action: TodoAction): DraftSequence {
  return normalizeSequence({
    ...sequence,
    todo: sequence.todo.map((item) => (item.sha === sha ? { ...item, action } : item))
  })
}

/** A melded commit needs a kept commit below it. Otherwise it becomes an ordinary one. */
function normalizeSequence(sequence: DraftSequence): DraftSequence {
  let seenKept = false
  return {
    ...sequence,
    todo: sequence.todo.map((item) => {
      if (item.action === 'drop') return item
      if (!seenKept) {
        seenKept = true
        return item.action === 'pick' ? item : { ...item, action: 'pick' as TodoAction }
      }
      return item
    })
  }
}

function isEditEmpty(edit: CommitEdit | undefined): boolean {
  return !edit || Object.values(edit).every((value) => value === undefined)
}

export function draftChangeCount(commits: Commit[], draft: Draft): number {
  const edited = Object.values(draft.edits).filter((edit) => !isEditEmpty(edit)).length
  if (!draft.sequence || !isSequenceChanged(commits, draft.sequence)) return edited
  const original = originalOrder(commits, draft.sequence)
  const structural = draft.sequence.todo.filter((item, index) => item.action !== 'pick' || item.sha !== original[index]).length
  return edited + structural
}

/**
 * Applies a draft to the loaded history so the graph shows the future state.
 * Dropped commits stay visible, marked, so that the user can bring them back.
 */
export function applyDraftToCommits(commits: Commit[], draft: Draft): DisplayCommit[] {
  const display = (commit: Commit): DisplayCommit => {
    const edit = draft.edits[commit.sha]
    const next: DisplayCommit = { ...commit, draftStates: [] }
    if (edit && !isEditEmpty(edit)) {
      const message = edit.message?.replace(/\s+$/, '')
      if (message !== undefined) {
        next.message = message
        next.subject = message.split('\n')[0]
      }
      next.authorName = edit.authorName ?? next.authorName
      next.authorEmail = edit.authorEmail ?? next.authorEmail
      next.authorDate = edit.authorDate ?? next.authorDate
      next.committerName = edit.committerName ?? next.committerName
      next.committerEmail = edit.committerEmail ?? next.committerEmail
      next.committerDate = edit.committerDate ?? next.committerDate
      next.draftStates.push('edited')
    }
    return next
  }
  const sequence = draft.sequence
  if (!sequence || !isSequenceChanged(commits, sequence)) return commits.map(display)

  const original = originalOrder(commits, sequence)
  const originalIndex = new Map(original.map((sha, index) => [sha, index]))
  const actionOf = new Map(sequence.todo.map((item) => [item.sha, item.action]))
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]))
  // The new order fills the slots the chain occupied in the list, newest first.
  const newestFirst = [...sequence.todo].reverse().map((item) => item.sha)
  const newTip = newestFirst[0]
  let slot = 0
  const result: DisplayCommit[] = []
  for (const commit of commits) {
    if (!originalIndex.has(commit.sha)) {
      const next = display(commit)
      next.parents = next.parents.map((parent) => (parent === sequence.tip ? newTip : parent))
      result.push(next)
      continue
    }
    const sha = newestFirst[slot]
    const next = display(bySha.get(sha)!)
    next.parents = slot + 1 < newestFirst.length ? [newestFirst[slot + 1]] : sequence.base ? [sequence.base] : []
    const action = actionOf.get(sha)
    if (action === 'drop') next.draftStates.push('dropped')
    else if (action === 'squash') next.draftStates.push('squashed')
    else if (action === 'fixup') next.draftStates.push('fixup')
    const todoIndex = sequence.todo.findIndex((item) => item.sha === sha)
    if (originalIndex.get(sha) !== todoIndex) next.draftStates.push('moved')
    result.push(next)
    slot++
  }
  return result
}

/** Turns a draft into an engine plan, leaving untouched old commits out of the sequence. */
export function buildPlan(commits: Commit[], draft: Draft): RewritePlan {
  const edits: Record<string, CommitEdit> = {}
  for (const [sha, edit] of Object.entries(draft.edits)) {
    if (!isEditEmpty(edit)) edits[sha] = edit
  }
  const plan: RewritePlan = { edits }
  const parts: string[] = []
  if (Object.keys(edits).length) parts.push(`правка коммитов: ${Object.keys(edits).length}`)
  const sequence = draft.sequence
  if (sequence && isSequenceChanged(commits, sequence)) {
    const original = originalOrder(commits, sequence)
    let base = sequence.base
    let start = 0
    while (start < sequence.todo.length - 1) {
      const item = sequence.todo[start]
      const next = sequence.todo[start + 1]
      if (item.action !== 'pick' || item.sha !== original[start] || next.action === 'squash' || next.action === 'fixup') break
      base = item.sha
      start++
    }
    plan.sequence = { base, tip: sequence.tip, todo: sequence.todo.slice(start) }
    parts.push(`перестройка ветки ${sequence.branch}`)
  }
  plan.description = parts.join(', ') || 'Правка истории'
  return plan
}
