import { describe, expect, it } from 'vitest'
import {
  applyDraftToCommits, buildPlan, draftChangeCount, EMPTY_DRAFT, isSequenceChanged, linearChain,
  moveInSequence, setAction, squashInSequence, startSequence
} from '../src/shared/draft'
import { layoutGraph } from '../src/shared/graph'
import type { Commit } from '../src/shared/types'
import { applyRewrite } from '../src/core/rewrite'
import { readLog } from '../src/core/read'
import { commitFile, createRepo, log } from './helpers'

function commit(sha: string, parents: string[] = []): Commit {
  return {
    sha, parents, tree: `t${sha}`, authorName: 'A', authorEmail: 'a@e', authorDate: '2020-01-01T00:00:00Z',
    committerName: 'A', committerEmail: 'a@e', committerDate: '2020-01-01T00:00:00Z', subject: sha, message: sha
  }
}

// d - c - b - a, newest first
const line = [commit('d', ['c']), commit('c', ['b']), commit('b', ['a']), commit('a')]

describe('graph layout', () => {
  it('keeps a linear history in one lane', () => {
    const rows = layoutGraph(line)
    expect(rows.map((row) => row.column)).toEqual([0, 0, 0, 0])
    expect(rows[0].into).toEqual([])
    expect(rows[3].out).toEqual([])
  })

  it('opens and closes a lane around a merge', () => {
    const rows = layoutGraph([
      commit('m', ['b', 'f']),
      commit('f', ['a']),
      commit('b', ['a']),
      commit('a')
    ])
    expect(rows[0].out.map((edge) => edge.column)).toEqual([0, 1])
    expect(rows[1].column).toBe(1)
    expect(rows[2].column).toBe(0)
    expect(rows[2].through.map((edge) => edge.column)).toEqual([1])
    expect(rows[3].column).toBe(0)
    expect(rows[3].into.map((edge) => edge.column).sort()).toEqual([0, 1])
  })

  it('starts separate lanes for separate branch tips', () => {
    const rows = layoutGraph([commit('x', ['a']), commit('y', ['a']), commit('a')])
    expect(rows[0].column).toBe(0)
    expect(rows[1].column).toBe(1)
    expect(rows[0].color).not.toBe(rows[1].color)
  })
})

describe('draft', () => {
  const sequence = () => startSequence(line, 'main', 'd')!

  it('stops the chain at a merge commit', () => {
    const history = [commit('z', ['m']), commit('m', ['b', 'f']), commit('f', ['a']), commit('b', ['a']), commit('a')]
    expect(linearChain(history, 'z')).toEqual({ base: 'm', chain: ['z'] })
  })

  it('reaches the root on a linear history', () => {
    expect(linearChain(line, 'd')).toEqual({ base: null, chain: ['a', 'b', 'c', 'd'] })
  })

  it('moves commits in terms of the visual list', () => {
    const moved = moveInSequence(sequence(), 'd', 'b', 'below')
    expect(moved.todo.map((item) => item.sha)).toEqual(['a', 'd', 'b', 'c'])
    const up = moveInSequence(sequence(), 'a', 'c', 'above')
    expect(up.todo.map((item) => item.sha)).toEqual(['b', 'c', 'a', 'd'])
    expect(isSequenceChanged(line, moved)).toBe(true)
    expect(isSequenceChanged(line, sequence())).toBe(false)
  })

  it('melds a commit directly above its target', () => {
    const melded = squashInSequence(sequence(), 'd', 'b', 'squash')
    expect(melded.todo).toEqual([
      { sha: 'a', action: 'pick' },
      { sha: 'b', action: 'pick' },
      { sha: 'd', action: 'squash' },
      { sha: 'c', action: 'pick' }
    ])
  })

  it('turns a meld with nothing below it into a plain commit', () => {
    const dropped = setAction(setAction(sequence(), 'b', 'squash'), 'a', 'drop')
    expect(dropped.todo.find((item) => item.sha === 'b')?.action).toBe('pick')
  })

  it('shows the future order, parents and states', () => {
    const shown = applyDraftToCommits(line, {
      edits: { b: { message: 'renamed\n\nbody' } },
      sequence: setAction(moveInSequence(sequence(), 'd', 'b', 'below'), 'c', 'drop')
    })
    expect(shown.map((entry) => entry.sha)).toEqual(['c', 'b', 'd', 'a'])
    expect(shown[0].draftStates).toContain('dropped')
    expect(shown[1].subject).toBe('renamed')
    expect(shown[1].draftStates).toContain('edited')
    expect(shown[2].draftStates).toContain('moved')
    expect(shown[0].parents).toEqual(['b'])
    expect(shown[3].parents).toEqual([])
    expect(layoutGraph(shown).every((row) => row.column === 0)).toBe(true)
  })

  it('keeps commits above the tip attached to the new top', () => {
    const history = [commit('s', ['d']), ...line]
    const shown = applyDraftToCommits(history, {
      edits: {},
      sequence: moveInSequence(startSequence(history, 'main', 'd')!, 'd', 'c', 'below')
    })
    expect(shown[0].parents).toEqual(['c'])
  })

  it('counts changes and ignores empty edits', () => {
    expect(draftChangeCount(line, EMPTY_DRAFT)).toBe(0)
    expect(draftChangeCount(line, { edits: { a: { message: undefined } }, sequence: sequence() })).toBe(0)
    expect(draftChangeCount(line, { edits: { a: { message: 'x' } }, sequence: setAction(sequence(), 'd', 'drop') })).toBe(2)
  })

  it('trims untouched old commits out of the plan', () => {
    const plan = buildPlan(line, { edits: {}, sequence: moveInSequence(sequence(), 'd', 'c', 'below') })
    expect(plan.sequence?.base).toBe('b')
    expect(plan.sequence?.todo.map((item) => item.sha)).toEqual(['d', 'c'])
  })

  it('keeps the head of a meld when trimming', () => {
    const plan = buildPlan(line, { edits: {}, sequence: setAction(sequence(), 'b', 'fixup') })
    expect(plan.sequence?.base).toBe(null)
    expect(plan.sequence?.todo[0].sha).toBe('a')
  })

  it('leaves the sequence out when only metadata changed', () => {
    expect(buildPlan(line, { edits: { a: { message: 'x' } }, sequence: sequence() }).sequence).toBeUndefined()
  })

  it('produces plans the engine applies to the state the graph promised', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    await commitFile(dir, 'b.txt', '2\n', 'two')
    await commitFile(dir, 'c.txt', '3\n', 'three')
    await commitFile(dir, 'd.txt', '4\n', 'four')
    const commits = await readLog(dir)
    const [four, three, two] = commits
    const draft = {
      edits: { [two.sha]: { message: 'two renamed' } },
      sequence: setAction(moveInSequence(startSequence(commits, 'main', four.sha)!, four.sha, two.sha, 'below'), three.sha, 'drop')
    }
    const promised = applyDraftToCommits(commits, draft)
      .filter((entry) => !entry.draftStates.includes('dropped'))
      .map((entry) => entry.subject)
    await applyRewrite(dir, buildPlan(commits, draft))
    expect(await log(dir)).toEqual(promised)
  })
})
