import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import type { SessionsState } from './protocol'

// Every test stops its workers and removes its repositories, even when an assertion fails
const workers: { deactivate(): Promise<void> }[] = []
const dirs: string[] = []
type Worker = Awaited<ReturnType<typeof mountWorker>>
async function mount(host: ReturnType<typeof mockHost>): Promise<Worker> {
  const w = await mountWorker(main, { host })
  workers.push(w)
  return w
}
function t(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    try {
      await fn()
    } finally {
      main.TUNING.eventGapMs = 2000
      for (const w of workers.splice(0)) await w.deactivate().catch(() => undefined)
      for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => undefined)
    }
  })
}

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=a@acme.test', '-c', 'user.name=acme', ...args], { cwd, env: ENV, stdio: 'ignore' })
}
async function repo(dirty = false): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'acme-ws-'))
  dirs.push(d)
  git(d, 'init', '-q', '-b', 'main')
  await writeFile(join(d, 'a.txt'), 'a\n')
  git(d, 'add', '.')
  git(d, 'commit', '-q', '-m', 'init')
  git(d, 'checkout', '-q', '-b', 'feat') // no upstream, nothing in a base branch: yellow
  if (dirty) await writeFile(join(d, 'a.txt'), 'changed\n')
  return d
}
/** A repository on main that is in sync with a bare remote */
async function withRemote(): Promise<{ dir: string }> {
  const remote = await mkdtemp(join(tmpdir(), 'acme-remote-'))
  dirs.push(remote)
  git(remote, 'init', '-q', '--bare', '-b', 'main')
  const dir = await repo()
  git(dir, 'checkout', '-q', 'main')
  git(dir, 'remote', 'add', 'origin', remote)
  git(dir, 'push', '-q', '-u', 'origin', 'main')
  git(dir, 'remote', 'set-head', 'origin', 'main')
  return { dir }
}
/** Waits until the check is true (up to 5 s) instead of sleeping a fixed time: scans take as long as git takes */
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
}
type Ws = { id: string; kind: 'worktree' | 'folder'; name: string; project?: string; path: string; branch: string | null; hostId: string | null; status?: { state: 'working' | 'permission' | 'done' | 'active' | 'inactive'; unread: boolean; terminalCount: number; lastActivityAt: number | null } }
const ws = (id: string, path: string, extra: Partial<Ws> = {}): Ws => ({ id, kind: 'worktree', name: id, project: 'acme-shop', path, branch: 'feat', hostId: null, ...extra })
const list = (workspaces: Ws[], extra: object = {}) => ({ workspaces, truncated: false, ...extra })
const status = (state: 'working' | 'permission' | 'done' | 'active' | 'inactive') => ({ state, unread: false, terminalCount: 1, lastActivityAt: null })

t('lists local worktrees with their git state, dirty ones first', async () => {
  const clean = await repo()
  const dirty = await repo(true)
  const host = mockHost({ results: { 'workspace.list': list([ws('w-clean', clean, { name: 'a-clean' }), ws('w-dirty', dirty, { name: 'z-dirty' })]) } })
  const worker = await mount(host)
  const s = (await worker.request('sessions.get')) as SessionsState
  assert.deepEqual(s.sessions.map((x) => [x.id, x.verdict, x.uncommitted]), [['w-dirty', 'keep', 1], ['w-clean', 'check', 0]])
  assert.deepEqual(host.callsOf('workspace.list'), [{ includeStatus: true }])
  assert.deepEqual(worker.refusals, [])
})

t('folders, remote workspaces and bad paths are not scanned and say why', async () => {
  const dir = await repo()
  const host = mockHost({
    results: {
      'workspace.list': list([
        ws('folder', dir, { kind: 'folder', branch: null }),
        ws('remote', dir, { hostId: 'ssh:acme' }),
        ws('rel', 'relative/path'),
        ws('dash', '-C'),
        ws('local', dir, { hostId: 'local' })
      ])
    }
  })
  const worker = await mount(host)
  const s = (await worker.request('sessions.get')) as SessionsState
  const by = Object.fromEntries(s.sessions.map((x) => [x.id, x]))
  assert.equal(by.folder.verdict, 'unknown')
  assert.equal(by.folder.error, 'folder workspace, not checked')
  assert.equal(by.remote.error, 'remote workspace, not checked')
  assert.equal(by.rel.error, 'invalid path')
  assert.equal(by.dash.error, 'invalid path')
  assert.notEqual(by.local.verdict, 'unknown')
})

t('a running agent keeps the session, also when git cannot be read', async () => {
  const dir = await repo()
  const host = mockHost({
    results: {
      'workspace.list': list([
        ws('busy', dir, { status: status('working') }),
        ws('wait', dir, { status: status('permission') }),
        ws('gone', '/nonexistent-acme-path', { status: status('working') }),
        ws('gone2', '/nonexistent-acme-path')
      ])
    }
  })
  const worker = await mount(host)
  const s = (await worker.request('sessions.get')) as SessionsState
  const by = Object.fromEntries(s.sessions.map((x) => [x.id, x]))
  assert.equal(by.busy.verdict, 'keep')
  assert.ok(by.busy.reasons.includes('agent working'))
  assert.equal(by.wait.verdict, 'keep')
  assert.equal(by.gone.verdict, 'keep')
  assert.equal(by.gone2.verdict, 'unknown')
  assert.equal(by.gone2.error, 'folder not found')
})

t('truncated agent status turns a clean worktree yellow, not green', async () => {
  const dir = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w', dir, { branch: 'main' })], { statusTruncated: true }) } })
  const worker = await mount(host)
  const s = (await worker.request('sessions.get')) as SessionsState
  assert.ok(s.sessions[0].reasons.includes('agent status unknown'))
})

t('at most 100 workspaces are scanned and the list says it is cut', async () => {
  const many = Array.from({ length: 130 }, (_, i) => ws(`w${i}`, '/nonexistent-acme-path'))
  const host = mockHost({ results: { 'workspace.list': list(many) } })
  const worker = await mount(host)
  const s = (await worker.request('sessions.get')) as SessionsState
  assert.equal(s.sessions.length, 100)
  assert.equal(s.truncated, true)
})

t('the workspace list failing is an error for the panel, not a crash', async () => {
  const host = mockHost({ results: { 'workspace.list': () => { throw hostError('unavailable', 'down') } } })
  const worker = await mount(host)
  await assert.rejects(() => worker.request('sessions.get'), /Could not list the workspaces/)
})

t('the current workspace comes from workspace.changed', async () => {
  const a = await repo()
  const b = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', a), ws('w2', b)]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await worker.emit('workspace.changed', { context: { workspaceId: 'w2', branch: 'feat', displayName: 'w2', terminals: [] } })
  const last = worker.posts.at(-1)?.payload as SessionsState
  assert.deepEqual(last.sessions.filter((x) => x.current).map((x) => x.id), ['w2'])
  await worker.emit('workspace.changed', { context: null })
  assert.equal((worker.posts.at(-1)?.payload as SessionsState).sessions.some((x) => x.current), false)
})

t('events rescan only while the panel is open, and only the workspace concerned', async () => {
  const a = await repo()
  const b = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', a), ws('w2', b)]) } })
  const worker = await mount(host)
  const event = (id: string) => ({ workspaceId: null, workspaceListId: id, paneKey: 'p', state: 'working' as const, receivedAt: 1 })
  // before the panel asked for anything: no work
  await worker.emit('agent.status.changed', event('w1'))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(host.callsOf('workspace.list').length, 0)
  await worker.request('sessions.get')
  assert.equal(host.callsOf('workspace.list').length, 1)
  await writeFile(join(a, 'new.txt'), 'x\n')
  await worker.emit('agent.status.changed', event('w1'))
  await until(() => host.callsOf('workspace.list').length >= 2)
  assert.equal(host.callsOf('workspace.list').length, 2)
  // the call count rises when the scan starts: wait for its result, not for its start
  let s = (await worker.request('sessions.get')) as SessionsState
  for (let i = 0; i < 100 && s.sessions.find((x) => x.id === 'w1')?.untracked !== 1; i++) {
    await new Promise((r) => setTimeout(r, 50))
    s = (await worker.request('sessions.get')) as SessionsState
  }
  assert.equal(s.sessions.find((x) => x.id === 'w1')?.untracked, 1)
})

t('only changes are pushed to the panel', async () => {
  const dir = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir)]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  const before = worker.posts.length
  await worker.request('sessions.refresh')
  await worker.request('sessions.refresh')
  assert.equal(worker.posts.length, before)
  await writeFile(join(dir, 'a.txt'), 'changed\n')
  await worker.request('sessions.refresh')
  assert.equal(worker.posts.length, before + 1)
})

t('concurrent refreshes share one scan', async () => {
  const dir = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir)]) } })
  const worker = await mount(host)
  await Promise.all([worker.request('sessions.refresh'), worker.request('sessions.refresh'), worker.request('sessions.refresh')])
  assert.equal(host.callsOf('workspace.list').length, 1)
})

t('open only takes ids from the list and only calls workspace.open', async () => {
  const dir = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir)]), 'workspace.open': { opened: true } } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await worker.request('session.open', { id: 'w1' })
  assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'w1' }])
  for (const bad of ['nope', '', 5, null, { id: 'w1' }]) {
    await assert.rejects(() => worker.request('session.open', { id: bad as never }), /Unknown workspace/)
  }
  assert.equal(host.callsOf('workspace.open').length, 1)
})

t('a refused open is reported with a fixed text', async () => {
  const dir = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir)]), 'workspace.open': () => { throw hostError('action_failed', '/secret/path') } } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await assert.rejects(() => worker.request('session.open', { id: 'w1' }), /Could not open the workspace/)
})

t('hiding is stored and forgotten when the workspace is gone', async () => {
  const dir = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir), ws('w2', dir)]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  const s = (await worker.request('session.hide', { id: 'w1', hidden: true })) as SessionsState
  assert.deepEqual(s.sessions.filter((x) => x.hidden).map((x) => x.id), ['w1'])
  assert.deepEqual(host.data().storage.hidden, { w1: 'check' })
  await assert.rejects(() => worker.request('session.hide', { id: 'w1', hidden: 'yes' as never }), /Invalid request/)
  host.respond('workspace.list', list([ws('w2', dir)]))
  await worker.request('sessions.refresh')
  assert.deepEqual(host.data().storage.hidden, {})
})

t('settings are read, clamped and validated', async () => {
  const host = mockHost({ results: { 'workspace.list': list([]) }, settings: { intervalSeconds: 2, baseBranch: ' origin/dev ' } })
  const worker = await mount(host)
  assert.deepEqual(await worker.request('config.get'), { baseBranch: 'origin/dev', intervalSeconds: 10 })
  assert.deepEqual(await worker.request('config.set', { intervalSeconds: 9999 }), { baseBranch: 'origin/dev', intervalSeconds: 300 })
  await worker.request('config.set', { intervalSeconds: 'x' as never, baseBranch: 5 as never })
  assert.deepEqual(await worker.request('config.get'), { baseBranch: 'origin/dev', intervalSeconds: 300 })
})

t('the refresh command scans and counts', async () => {
  const dir = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir), ws('w2', dir)]) } })
  const worker = await mount(host)
  assert.equal(await worker.command('refresh'), '2 worktrees')
})

t('the worker only needs workspace and agent read, workspace write for open', async () => {
  const dir = await repo()
  // without workspace:write the open call is refused by the host, everything else works
  const host = mockHost({ capabilities: ['workspace:read', 'agent:read', 'storage:own', 'settings:own'], results: { 'workspace.list': list([ws('w1', dir)]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  assert.deepEqual(worker.refusals, [])
  await assert.rejects(() => worker.request('session.open', { id: 'w1' }), /Could not open the workspace/)
  assert.equal(worker.refusals.length, 1)
})

t('a hidden worktree is shown again as soon as it has open work', async () => {
  const dir = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir, { branch: 'main' })]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  // a clean worktree can be hidden ...
  git(dir, 'checkout', '-q', 'main')
  const hiddenState = (await worker.request('session.hide', { id: 'w1', hidden: true })) as SessionsState
  assert.equal(hiddenState.sessions[0].hidden, true)
  // ... and comes back when files change
  await writeFile(join(dir, 'a.txt'), 'changed\n')
  const s = (await worker.request('sessions.refresh')) as SessionsState
  assert.equal(s.sessions[0].hidden, false)
  assert.deepEqual(host.data().storage.hidden, {})
})

t('a worktree with open work cannot be hidden', async () => {
  const dir = await repo(true)
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir)]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await assert.rejects(() => worker.request('session.hide', { id: 'w1', hidden: true }), /open work/)
  assert.equal(host.data().storage.hidden, undefined)
})

t('the age comes from the last commit and from Orca', async () => {
  const dir = await repo()
  const at = Date.now() - 5000
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir, { status: { ...status('done'), lastActivityAt: at } })]) } })
  const worker = await mount(host)
  const s = (await worker.request('sessions.get')) as SessionsState
  assert.equal(s.sessions[0].lastActiveAt, at)
  assert.ok(s.sessions[0].lastCommitAt !== null)
})

t('a worktree hidden while safe comes back as soon as it gets worse, also to yellow', async () => {
  const { dir } = await withRemote()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir, { branch: 'main' })]) } })
  const worker = await mount(host)
  assert.equal(((await worker.request('sessions.get')) as SessionsState).sessions[0].verdict, 'safe')
  await worker.request('session.hide', { id: 'w1', hidden: true })
  assert.deepEqual(host.data().storage.hidden, { w1: 'safe' })
  await writeFile(join(dir, 'new.txt'), 'untracked\n')
  const s = (await worker.request('sessions.refresh')) as SessionsState
  assert.equal(s.sessions[0].verdict, 'check')
  assert.equal(s.sessions[0].hidden, false)
})

t('a not checked folder workspace can stay hidden', async () => {
  const dir = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('f1', dir, { kind: 'folder', branch: null })]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await worker.request('session.hide', { id: 'f1', hidden: true })
  const s = (await worker.request('sessions.refresh')) as SessionsState
  assert.equal(s.sessions[0].hidden, true)
})

t('an old stored list of ids still works and counts as hidden while safe', async () => {
  const { dir } = await withRemote()
  const host = mockHost({ storage: { hidden: ['w1'] }, results: { 'workspace.list': list([ws('w1', dir, { branch: 'main' })]) } })
  const worker = await mount(host)
  assert.equal(((await worker.request('sessions.get')) as SessionsState).sessions[0].hidden, true)
  await writeFile(join(dir, 'x.txt'), 'x\n')
  assert.equal(((await worker.request('sessions.refresh')) as SessionsState).sessions[0].hidden, false)
})

t('names, branches and upstreams are cleaned of control and bidi characters', async () => {
  const dir = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir, { name: 'ok\u202eevil', project: 'p\nq', branch: 'feat' })]) } })
  const worker = await mount(host)
  const s = ((await worker.request('sessions.get')) as SessionsState).sessions[0]
  assert.equal(s.name, 'ok?evil')
  assert.equal(s.project, 'p?q')
})

t('a gone upstream is a yellow worktree, not a green one', async () => {
  const remote = await mkdtemp(join(tmpdir(), 'acme-remote-'))
  dirs.push(remote)
  git(remote, 'init', '-q', '--bare', '-b', 'main')
  const dir = await repo()
  git(dir, 'checkout', '-q', 'main')
  git(dir, 'remote', 'add', 'origin', remote)
  git(dir, 'push', '-q', '-u', 'origin', 'main')
  git(dir, 'checkout', '-q', 'feat')
  git(dir, 'push', '-q', '-u', 'origin', 'feat')
  await writeFile(join(dir, 'w.txt'), 'w\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'only here')
  git(dir, 'push', '-q', 'origin', '--delete', 'feat')
  git(dir, 'fetch', '-q', '--prune')
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir)]) } })
  const worker = await mount(host)
  const s = ((await worker.request('sessions.get')) as SessionsState).sessions[0]
  assert.equal(s.verdict, 'check')
  assert.ok(s.reasons.join(' ').includes('upstream branch is gone'))
})

t('workspace.created and workspace.removed rescan while the panel is open', async () => {
  main.TUNING.eventGapMs = 20
  const a = await repo()
  const b = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', a)]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  host.respond('workspace.list', list([ws('w1', a), ws('w2', b)]))
  await worker.emit('workspace.created', { workspaceId: 'w2', workspaceListId: 'w2', kind: 'worktree', path: b, branch: 'feat' })
  await until(() => host.callsOf('workspace.list').length >= 2)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(((await worker.request('sessions.get')) as SessionsState).sessions.length, 2)
  host.respond('workspace.list', list([ws('w1', a)]))
  await worker.emit('workspace.removed', { workspaceId: 'w2', workspaceListId: 'w2', kind: 'worktree', path: b })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(((await worker.request('sessions.get')) as SessionsState).sessions.length, 1)
  main.TUNING.eventGapMs = 2000
})

t('a storm of events makes scans with a pause, and a running scan does not swallow a targeted one', async () => {
  main.TUNING.eventGapMs = 400
  try {
    const a = await repo()
    const host = mockHost({ results: { 'workspace.list': list([ws('w1', a)]) } })
    const worker = await mount(host)
    await worker.request('sessions.get')
    const base = host.callsOf('workspace.list').length
    const event = { workspaceId: null, workspaceListId: 'w1', paneKey: 'p', state: 'working' as const, receivedAt: 1 }
    for (let i = 0; i < 20; i++) await worker.emit('agent.status.changed', event)
    await new Promise((r) => setTimeout(r, 150))
    // the first one ran at once, the other 19 are one pending scan that waits for the pause
    assert.equal(host.callsOf('workspace.list').length, base + 1)
    await new Promise((r) => setTimeout(r, 700))
    assert.equal(host.callsOf('workspace.list').length, base + 2)
  } finally {
    main.TUNING.eventGapMs = 2000
  }
})

t('the hidden list in the new format is read after a restart', async () => {
  const { dir } = await withRemote()
  const host = mockHost({ storage: { hidden: { w1: 'check' } }, results: { 'workspace.list': list([ws('w1', dir, { branch: 'main' })]) } })
  const worker = await mount(host)
  assert.equal(((await worker.request('sessions.get')) as SessionsState).sessions[0].hidden, true)
})

t('hidden worktrees are not forgotten when the list is empty or cut', async () => {
  const dir = await repo()
  const host = mockHost({ storage: { hidden: { w1: 'check' } }, results: { 'workspace.list': list([]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  assert.deepEqual(host.data().storage.hidden, { w1: 'check' })
  host.respond('workspace.list', list([ws('w2', dir)], { truncated: true }))
  await worker.request('sessions.refresh')
  assert.deepEqual(host.data().storage.hidden, { w1: 'check' })
  // a full list without w1 forgets it
  host.respond('workspace.list', list([ws('w2', dir)]))
  await worker.request('sessions.refresh')
  assert.deepEqual(host.data().storage.hidden, {})
})

t('a refresh from the panel waits for a running targeted scan and reads every repository', async () => {
  const a = await repo()
  const b = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', a), ws('w2', b)]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await writeFile(join(b, 'late.txt'), 'x\n')
  const event = { workspaceId: null, workspaceListId: 'w1', paneKey: 'p', state: 'working' as const, receivedAt: 1 }
  await worker.emit('agent.status.changed', event)
  const s = (await worker.request('sessions.refresh')) as SessionsState
  assert.equal(s.sessions.find((x) => x.id === 'w2')?.untracked, 1)
})
