import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Session, SessionsState } from './protocol'

// Unmount even when an assertion fails: the panel's refresh timer would keep node alive
const views: { unmount(): Promise<void> }[] = []
async function open(host: ReturnType<typeof mockHost>) {
  const v = await mount(panel, { host })
  views.push(v)
  return v
}
function t(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    try {
      await fn()
    } finally {
      for (const v of views.splice(0)) await v.unmount().catch(() => undefined)
    }
  })
}

const cfg = { baseBranch: '', intervalSeconds: 30 }
const base: Session = {
  id: '', name: '', project: 'acme-shop', branch: 'main', current: false, hidden: false, verdict: 'safe', reasons: ['clean, nothing unpushed'],
  uncommitted: 0, staged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, upstream: 'origin/main', upstreamGone: false, submodules: false, stash: 0, stashTotal: 0,
  merged: null, operation: null, agent: null, files: [], moreFiles: 0, error: null, lastCommitAt: null, lastActiveAt: null, unpushed: [], added: null, removed: null, dirtySince: null, checkedAt: 1
}
const dirty: Session = {
  ...base, id: 'w1', name: 'checkout', verdict: 'keep', reasons: ['3 uncommitted', '2 unpushed'], uncommitted: 3, ahead: 2,
  files: [{ state: '.M', path: 'src/cart.tsx' }], moreFiles: 2
}
const safe: Session = { ...base, id: 'w2', name: 'docs' }
const state = (sessions: Session[], extra: Partial<SessionsState> = {}): SessionsState => ({ sessions, truncated: false, updatedAt: 1, ...extra })

t('shows the number of worktrees with uncommitted files and the rows', async () => {
  const host = mockHost({ requests: { 'sessions.get': state([dirty, safe]), 'sessions.refresh': state([dirty, safe]), 'config.get': cfg } })
  const view = await open(host)
  assert.ok(view.find({ text: '1 worktree with uncommitted files' }))
  assert.ok(view.find({ text: 'Uncommitted files' }))
  assert.ok(view.find({ text: '3 changed' }))
  assert.ok(view.find({ text: '2 unpushed' }))
  assert.ok(view.find({ text: 'acme-shop / checkout' }))
  assert.ok(view.find({ text: /Can close/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

t('all committed when nothing is dirty', async () => {
  const host = mockHost({ requests: { 'sessions.get': state([safe]), 'sessions.refresh': state([safe]), 'config.get': cfg } })
  const view = await open(host)
  assert.ok(view.find({ text: 'Everything is committed' }))
  assert.ok(view.find({ text: 'clean' }))
  await view.unmount()
})

t('the filter shows only worktrees with uncommitted files', async () => {
  const host = mockHost({ requests: { 'sessions.get': state([dirty, safe]), 'sessions.refresh': state([dirty, safe]), 'config.get': cfg } })
  const view = await open(host)
  assert.ok(view.find({ text: 'acme-shop / docs' }))
  await view.press({ text: 'Uncommitted 1' })
  assert.ok(view.find({ text: 'acme-shop / checkout' }))
  assert.equal(view.find({ text: 'acme-shop / docs' }), null)
  await view.press({ text: 'All 2' })
  assert.ok(view.find({ text: 'acme-shop / docs' }))
  await view.unmount()
})

t('Open calls the worker with the workspace id', async () => {
  const calls: string[] = []
  const host = mockHost({
    requests: {
      'sessions.get': state([dirty]),
      'sessions.refresh': state([dirty]),
      'config.get': cfg,
      'session.open': (input) => {
        calls.push(input.id)
        return { ok: true }
      }
    }
  })
  const view = await open(host)
  await view.press({ text: 'Open' })
  assert.deepEqual(calls, ['w1'])
  await view.unmount()
})

t('a failing open shows the message', async () => {
  const host = mockHost({
    requests: {
      'sessions.get': state([dirty]),
      'sessions.refresh': state([dirty]),
      'config.get': cfg,
      'session.open': () => {
        throw new Error('Could not open the workspace')
      }
    }
  })
  const view = await open(host)
  await view.press({ text: 'Open' })
  assert.ok(view.find({ text: 'Could not open the workspace' }))
  await view.unmount()
})

t('file names are shown as plain text', async () => {
  const evil: Session = { ...dirty, files: [{ state: '??', path: '<img src=x onerror=alert(1)>' }] }
  const host = mockHost({ requests: { 'sessions.get': state([evil]), 'sessions.refresh': state([evil]), 'config.get': cfg } })
  const view = await open(host)
  await view.toggle({ label: /Files/ })
  // the markup is text: no element is made from it
  assert.ok(view.find({ text: /onerror=alert/ }))
  assert.equal(view.find({ type: 'Image' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

t('a truncated list and an empty list say so', async () => {
  const host = mockHost({ requests: { 'sessions.get': state([safe], { truncated: true }), 'sessions.refresh': state([safe], { truncated: true }), 'config.get': cfg } })
  const view = await open(host)
  assert.ok(view.find({ text: 'Only the first 100 workspaces are checked.' }))
  await view.unmount()
  const empty = mockHost({ requests: { 'sessions.get': state([]), 'sessions.refresh': state([]), 'config.get': cfg } })
  const v2 = await open(empty)
  assert.ok(v2.summary().some((l) => l.includes('No workspaces')))
  await v2.unmount()
})

t('a worker error on load is shown, not thrown', async () => {
  const host = mockHost({
    requests: {
      'sessions.get': () => {
        throw new Error('Could not list the workspaces')
      },
      'config.get': cfg
    }
  })
  const view = await open(host)
  assert.ok(view.find({ text: 'Could not list the workspaces' }))
  await view.unmount()
})

t('grouping by project puts the worktrees of one project together', async () => {
  const a: Session = { ...dirty, id: 'a', name: 'one', project: 'acme-shop' }
  const b: Session = { ...safe, id: 'b', name: 'two', project: 'acme-docs' }
  const c: Session = { ...safe, id: 'c', name: 'three', project: 'acme-shop' }
  const host = mockHost({ requests: { 'sessions.get': state([a, b, c]), 'sessions.refresh': state([a, b, c]), 'config.get': cfg } })
  const view = await open(host)
  await view.press({ text: 'project' })
  const lines = view.summary()
  assert.ok(view.find({ text: 'acme-shop' }) && view.find({ text: 'acme-docs' }))
  assert.ok(lines.length > 0)
  assert.equal(view.find({ text: 'Uncommitted files' }), null)
  await view.unmount()
})

t('Hide asks the worker, a refusal is shown', async () => {
  const host = mockHost({
    requests: {
      'sessions.get': state([dirty]),
      'sessions.refresh': state([dirty]),
      'config.get': cfg,
      'session.hide': () => {
        throw new Error('This worktree still has open work and cannot be hidden')
      }
    }
  })
  const view = await open(host)
  await view.press({ text: 'Hide' })
  assert.ok(view.find({ text: 'This worktree still has open work and cannot be hidden' }))
  await view.unmount()
})

t('the age of a worktree is shown', async () => {
  const old: Session = { ...safe, lastCommitAt: Date.now() - 40 * 86_400_000 }
  const host = mockHost({ requests: { 'sessions.get': state([old]), 'sessions.refresh': state([old]), 'config.get': cfg } })
  const view = await open(host)
  assert.ok(view.findAll({ type: 'RelativeTime' }).length >= 1)
  await view.unmount()
})

t('the first files and the size of the change are on the card', async () => {
  const s: Session = {
    ...dirty, added: 120, removed: 30, dirtySince: Date.now() - 9 * 86_400_000,
    files: [{ state: '.M', path: 'src/cart.tsx' }, { state: '.M', path: 'src/checkout.tsx' }], moreFiles: 1
  }
  const host = mockHost({ requests: { 'sessions.get': state([s]), 'sessions.refresh': state([s]), 'config.get': cfg } })
  const view = await open(host)
  assert.ok(view.find({ text: '+120 -30 · src/cart.tsx, src/checkout.tsx +1' }))
  assert.ok(view.findAll({ type: 'RelativeTime' }).length >= 1)
  await view.unmount()
})

t('the unpushed commits are listed under Details', async () => {
  const s: Session = { ...base, id: 'u', name: 'feat', verdict: 'keep', ahead: 5, unpushed: ['fix cart', 'add hero', 'wip'] }
  const host = mockHost({ requests: { 'sessions.get': state([s]), 'sessions.refresh': state([s]), 'config.get': cfg } })
  const view = await open(host)
  await view.toggle({ label: /Details/ })
  assert.ok(view.find({ text: 'Unpushed: 5' }))
  assert.ok(view.find({ text: 'fix cart' }))
  assert.ok(view.find({ text: '…and 2 more' }))
  await view.unmount()
})

t('the search narrows the list by project, worktree and branch', async () => {
  const a: Session = { ...dirty, id: 'a', name: 'checkout', project: 'acme-shop', branch: 'feature/cart' }
  const b: Session = { ...safe, id: 'b', name: 'docs', project: 'acme-docs', branch: 'main' }
  const host = mockHost({ requests: { 'sessions.get': state([a, b]), 'sessions.refresh': state([a, b]), 'config.get': cfg } })
  const view = await open(host)
  await view.type({ label: 'Search worktrees' }, 'cart')
  assert.ok(view.find({ text: 'acme-shop / checkout' }))
  assert.equal(view.find({ text: 'acme-docs / docs' }), null)
  await view.type({ label: 'Search worktrees' }, 'nothing-like-this', { replace: true })
  assert.ok(view.summary().some((l) => l.includes('Nothing matches')))
  await view.unmount()
})

t('an unknown stored filter falls back to all', async () => {
  const host = mockHost({ requests: { 'sessions.get': state([dirty, safe]), 'sessions.refresh': state([dirty, safe]), 'config.get': cfg } })
  const v = await mount(panel, { host, persisted: { plugin: { filter: 'evil', grouping: 5 } } })
  views.push(v)
  assert.ok(v.find({ text: 'acme-shop / docs' }))
  await v.unmount()
})

t('the current session is pinned on top, also with a filter and a search', async () => {
  const cur: Session = { ...safe, id: 'c', name: 'mine', current: true }
  const host = mockHost({ requests: { 'sessions.get': state([dirty, cur]), 'sessions.refresh': state([dirty, cur]), 'config.get': cfg } })
  const view = await open(host)
  assert.ok(view.find({ text: 'Current session' }))
  await view.press({ text: 'Uncommitted 1' })
  assert.ok(view.find({ text: 'Current session' }))
  assert.ok(view.find({ text: 'acme-shop / mine' }))
  await view.type({ label: 'Search worktrees' }, 'checkout')
  assert.ok(view.find({ text: 'acme-shop / mine' }))
  // one card only: it is not repeated in its group
  assert.equal(view.findAll({ text: 'acme-shop / mine' }).length, 1)
  await view.unmount()
})
