import { assert, test } from 'orca/testing'
import { chips, groupOf } from './chips'
import type { Session } from './protocol'

const base: Session = {
  id: 'w', name: 'acme', project: 'acme-shop', branch: 'main', current: false, hidden: false, verdict: 'safe', reasons: [],
  uncommitted: 0, staged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, upstream: 'origin/main', upstreamGone: false, submodules: false, stash: 0, stashTotal: 0,
  merged: null, operation: null, agent: null, files: [], moreFiles: 0, error: null, lastCommitAt: null, lastActiveAt: null, unpushed: [], added: null, removed: null, dirtySince: null, checkedAt: 1
}
const texts = (s: Partial<Session>) => chips({ ...base, ...s }).map((c) => `${c.tone}:${c.text}`)

test('a clean worktree gets one green chip', () => {
  assert.deepEqual(texts({}), ['success:clean'])
})

test('open work is calm (blue, amber), red is only for conflicts and a running merge or rebase', () => {
  assert.deepEqual(
    texts({ uncommitted: 3, conflicts: 1, ahead: 2, agent: 'working', operation: 'merge', untracked: 4, stash: 1 }),
    ['accent:3 changed', 'danger:1 conflict', 'warning:2 unpushed', 'accent:agent working', 'danger:merge', 'neutral:4 untracked', 'neutral:1 stash']
  )
  assert.deepEqual(texts({ agent: 'permission' }), ['warning:agent waits'])
})

test('commits that are already in the base branch say merged, not unpushed', () => {
  assert.deepEqual(texts({ ahead: 2, merged: true }), ['success:merged'])
  assert.deepEqual(texts({ upstream: null, merged: true }), ['success:merged'])
  // open work stays the headline
  assert.deepEqual(texts({ uncommitted: 1, ahead: 2, merged: true }), ['accent:1 changed'])
})

test('no upstream and detached HEAD are yellow, unless merged', () => {
  assert.deepEqual(texts({ upstream: null }), ['neutral:no upstream'])
  assert.deepEqual(texts({ upstream: null, merged: true }), ['success:merged'])
  assert.deepEqual(texts({ branch: null, upstream: null }), ['neutral:detached'])
})

test('behind is neutral information', () => {
  assert.deepEqual(texts({ behind: 4 }), ['neutral:4 behind'])
})

test('an error is the only thing said about a worktree that was not checked', () => {
  assert.deepEqual(texts({ verdict: 'unknown', error: 'folder not found', upstream: null, branch: null }), ['neutral:folder not found'])
  assert.deepEqual(texts({ verdict: 'keep', agent: 'working', error: 'git timed out' }), ['accent:agent working', 'neutral:git timed out'])
})

test('groups: uncommitted files win over the verdict', () => {
  assert.equal(groupOf({ uncommitted: 2, verdict: 'keep' }), 'dirty')
  assert.equal(groupOf({ uncommitted: 0, verdict: 'keep' }), 'keep')
  assert.equal(groupOf({ uncommitted: 0, verdict: 'safe' }), 'safe')
  assert.equal(groupOf({ uncommitted: 0, verdict: 'unknown' }), 'unknown')
})

test('state codes read as words', async () => {
  const { stateLabel } = await import('./chips')
  assert.equal(stateLabel('??'), 'new')
  assert.equal(stateLabel('.M'), 'edited')
  assert.equal(stateLabel('M.'), 'edited, staged')
  assert.equal(stateLabel('MM'), 'edited, staged + edited')
  assert.equal(stateLabel('.D'), 'deleted')
  assert.equal(stateLabel('A.'), 'added, staged')
  assert.equal(stateLabel('R.'), 'renamed, staged')
  assert.equal(stateLabel('UU'), 'conflict')
  assert.equal(stateLabel('xyz'), 'xyz')
})
