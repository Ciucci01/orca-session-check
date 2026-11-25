import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
// Tests start from fixed timings: no background scan unless a test asks for one, no 15 s wait
const TEST_TUNING = { eventGapMs: 2000, minRescanMs: 0, startDelayMs: 1e9, secondMs: 1000, notifyGapMs: 10 * 60_000 }
function t(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    Object.assign(main.TUNING, TEST_TUNING)
    // English unless a test says otherwise, whatever the machine's locale is
    main.LOCALE.system = () => 'en-US'
    try {
      await fn()
    } finally {
      Object.assign(main.TUNING, TEST_TUNING)
      main.LOCALE.system = () => 'en-US'
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
const event = (id: string, state: 'working' | 'blocked' | 'waiting' | 'done', paneKey = `p-${id}`) => ({ workspaceId: null, workspaceListId: id, paneKey, state, receivedAt: 1 })
/** The newest state the worker pushed to the panel */
const lastState = (w: Worker) => [...w.posts].reverse().find((p) => p.event === 'sessions.changed')?.payload as SessionsState | undefined
const sessionOf = (w: Worker, id: string) => lastState(w)?.sessions.find((x) => x.id === id)
const checkedAt = (w: Worker, id: string) => sessionOf(w, id)?.checkedAt ?? 0
type Bar = { id: string; text: string; tone: string; tooltip: string }
const bars = (host: ReturnType<typeof mockHost>) => host.callsOf('statusBar.update') as Bar[]
const bar = (host: ReturnType<typeof mockHost>) => bars(host).at(-1)
const notes = (host: ReturnType<typeof mockHost>) => host.callsOf('notifications.show') as { title: string; body: string }[]
/** A repository with n tracked files changed */
async function dirtyRepo(n: number): Promise<string> {
  const d = await repo()
  for (let i = 0; i < n; i++) await writeFile(join(d, `f${i}.txt`), 'a\n')
  git(d, 'add', '.')
  git(d, 'commit', '-q', '-m', 'files')
  for (let i = 0; i < n; i++) await writeFile(join(d, `f${i}.txt`), 'changed\n')
  return d
}
const timeouts = () => (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((x) => x === 'Timeout').length

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

t('a main worktree is marked as one, a linked worktree is not', async () => {
  const { dir } = await withRemote()
  const linked = join(await mkdtemp(join(tmpdir(), 'acme-wt-')), 'tree')
  dirs.push(dirname(linked))
  git(dir, 'worktree', 'add', '-q', '-b', 'wt', linked)
  const host = mockHost({ results: { 'workspace.list': list([ws('w-main', dir, { branch: 'main' }), ws('w-linked', linked, { branch: 'wt' })]) } })
  const worker = await mount(host)
  const s = (await worker.request('sessions.get')) as SessionsState
  assert.deepEqual(s.sessions.map((x) => [x.id, x.verdict, x.mainWorktree]), [['w-linked', 'safe', false], ['w-main', 'safe', true]])
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

t('events rescan without the panel, and only the workspace concerned', async () => {
  main.TUNING.eventGapMs = 20
  const a = await repo()
  const b = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', a), ws('w2', b)]) } })
  const worker = await mount(host)
  // the panel never asks: the first event reads everything (the ids are not known yet)
  await worker.emit('agent.status.changed', event('w1', 'working'))
  await until(() => checkedAt(worker, 'w1') > 0 && checkedAt(worker, 'w2') > 0)
  const w2Before = checkedAt(worker, 'w2')
  const w1Before = checkedAt(worker, 'w1')
  await writeFile(join(a, 'new.txt'), 'x\n')
  await worker.emit('agent.status.changed', event('w1', 'working'))
  await until(() => sessionOf(worker, 'w1')?.untracked === 1)
  assert.equal(sessionOf(worker, 'w1')?.untracked, 1)
  assert.ok(checkedAt(worker, 'w1') > w1Before)
  assert.equal(checkedAt(worker, 'w2'), w2Before)
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
  const host = mockHost({ results: { 'workspace.list': list([]) }, settings: { intervalSeconds: 2, baseBranch: ' origin/dev ', backgroundSeconds: 10, notifyOnAgentDone: false } })
  const worker = await mount(host)
  assert.deepEqual(await worker.request('config.get'), { baseBranch: 'origin/dev', intervalSeconds: 10, notifyOnAgentDone: false, backgroundSeconds: 30, language: 'auto', warnSensitive: true })
  assert.deepEqual(await worker.request('config.set', { intervalSeconds: 9999 }), { baseBranch: 'origin/dev', intervalSeconds: 300, notifyOnAgentDone: false, backgroundSeconds: 30, language: 'auto', warnSensitive: true })
  await worker.request('config.set', { intervalSeconds: 'x' as never, baseBranch: 5 as never })
  assert.deepEqual(await worker.request('config.get'), { baseBranch: 'origin/dev', intervalSeconds: 300, notifyOnAgentDone: false, backgroundSeconds: 30, language: 'auto', warnSensitive: true })
  const bg = async (value: unknown) => ((await worker.request('config.set', { backgroundSeconds: value as never })) as { backgroundSeconds: number }).backgroundSeconds
  assert.equal(await bg(9999), 600)
  assert.equal(await bg(5), 30)
  assert.equal(await bg(0), 0)
  assert.equal(await bg(-3), 0)
  assert.equal(await bg(45.6), 46)
  assert.equal(await bg('120'), 46)
  assert.equal(await bg(Number.NaN), 46)
  assert.equal(await bg(null), 46)
  assert.equal(host.data().settings.backgroundSeconds, 46)
  await worker.request('config.set', { notifyOnAgentDone: 'yes' as never })
  assert.equal(((await worker.request('config.get')) as { notifyOnAgentDone: boolean }).notifyOnAgentDone, false)
  await worker.request('config.set', { notifyOnAgentDone: true })
  assert.equal(host.data().settings.notifyOnAgentDone, true)
})

t('without stored settings the defaults apply', async () => {
  const host = mockHost({ results: { 'workspace.list': list([]) } })
  const worker = await mount(host)
  assert.deepEqual(await worker.request('config.get'), { baseBranch: '', intervalSeconds: 30, notifyOnAgentDone: true, backgroundSeconds: 120, language: 'auto', warnSensitive: true })
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

// Status bar item

t('the status bar says ok when nothing is uncommitted', async () => {
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', await repo()), ws('f1', await repo(), { kind: 'folder', branch: null })]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  assert.deepEqual(bar(host), { id: 'sessions', text: 'Sessions ok', tone: 'success', tooltip: 'Session Check: every worktree is committed' })
})

t('the status bar counts the worktrees with uncommitted files and names the biggest in the tooltip', async () => {
  const dirs6 = [await dirtyRepo(1), await dirtyRepo(4), await dirtyRepo(2), await dirtyRepo(6), await dirtyRepo(3), await dirtyRepo(5)]
  const rows = dirs6.map((d, i) => ws(`w${i}`, d, { name: `wt${i}` }))
  const host = mockHost({ results: { 'workspace.list': list([...rows, ws('clean', await repo())]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  const b = bar(host)
  assert.equal(b?.text, 'Sessions 6 open')
  assert.equal(b?.tone, 'warning')
  assert.equal(b?.tooltip, 'Uncommitted files: acme-shop / wt3 (6), acme-shop / wt5 (5), acme-shop / wt1 (4), acme-shop / wt4 (3), acme-shop / wt2 (2), +1 more')
  // no file names, only counts and names of worktrees
  assert.ok(!b?.tooltip.includes('.txt'))
})

t('hidden worktrees do not count in the status bar', async () => {
  const host = mockHost({ storage: { hidden: { w1: 'keep' } }, results: { 'workspace.list': list([ws('w1', await repo(true)), ws('w2', await repo())]) } })
  const worker = await mount(host)
  const s = (await worker.request('sessions.get')) as SessionsState
  assert.equal(s.sessions.find((x) => x.id === 'w1')?.hidden, true)
  assert.equal(bar(host)?.text, 'Sessions ok')
})

t('unknown worktrees are never ok: ? when none could be checked, unchecked otherwise', async () => {
  const host = mockHost({ results: { 'workspace.list': list([ws('g1', '/nonexistent-acme-path'), ws('g2', '/nonexistent-acme-path')]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  assert.equal(bar(host)?.text, 'Sessions ?')
  host.respond('workspace.list', list([ws('g1', '/nonexistent-acme-path'), ws('w1', await repo())]))
  await worker.request('sessions.refresh')
  assert.equal(bar(host)?.text, 'Sessions 1 unchecked')
  assert.notEqual(bar(host)?.tone, 'success')
  // a dirty one is still counted as open
  host.respond('workspace.list', list([ws('g1', '/nonexistent-acme-path'), ws('w1', await repo(true))]))
  await worker.request('sessions.refresh')
  assert.equal(bar(host)?.text, 'Sessions 1 open')
})

t('the status bar shows ? when the workspaces cannot be listed at all', async () => {
  const host = mockHost({ results: { 'workspace.list': () => { throw hostError('unavailable', 'down') } } })
  const worker = await mount(host)
  await assert.rejects(() => worker.request('sessions.get'))
  assert.equal(bar(host)?.text, 'Sessions ?')
})

t('the status bar is only updated when its text changes', async () => {
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', await repo())]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await worker.request('sessions.refresh')
  await worker.request('sessions.refresh')
  assert.equal(bars(host).length, 1)
})

t('clicking the status bar item runs the rescan command', async () => {
  const manifest = JSON.parse(await readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8')) as {
    contributes: { statusBarItems: { id: string; command?: string }[]; commands: { id: string }[] }
  }
  const item = manifest.contributes.statusBarItems.find((x) => x.id === 'sessions')
  assert.equal(item?.command, 'refresh')
  assert.ok(manifest.contributes.commands.some((c) => c.id === item?.command))
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', await repo(true))]) } })
  const worker = await mount(host)
  assert.equal(await worker.command('refresh'), '1 worktree')
  assert.equal(bar(host)?.text, 'Sessions 1 open')
})

t('a workspace is not read again on account of events within the minimum gap', async () => {
  main.TUNING.eventGapMs = 0
  main.TUNING.minRescanMs = 400
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', await repo())]) } })
  const worker = await mount(host)
  const start = Date.now()
  await worker.request('sessions.get')
  for (let i = 0; i < 5; i++) await worker.emit('agent.status.changed', event('w1', 'working'))
  await new Promise((r) => setTimeout(r, 100))
  // the events wait for the gap, they are not dropped
  assert.equal(host.callsOf('workspace.list').length, 1)
  await until(() => host.callsOf('workspace.list').length >= 2)
  assert.ok(Date.now() - start >= 400)
  assert.equal(host.callsOf('workspace.list').length, 2)
})

// Background refresh

t('the background timer fills the status bar without the panel, repeats and is cleared on deactivate', async () => {
  main.TUNING.eventGapMs = 0
  main.TUNING.startDelayMs = 10
  main.TUNING.secondMs = 1 // 30 configured seconds = 30 ms
  const before = timeouts()
  const host = mockHost({ settings: { backgroundSeconds: 30 }, results: { 'workspace.list': list([]) } })
  const worker = await mount(host)
  await until(() => host.callsOf('workspace.list').length >= 3)
  assert.ok(host.callsOf('workspace.list').length >= 3)
  assert.equal(bar(host)?.text, 'Sessions ok')
  assert.deepEqual(worker.posts.filter((p) => p.event !== 'sessions.changed'), [])
  await worker.deactivate()
  const count = host.callsOf('workspace.list').length
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(host.callsOf('workspace.list').length, count)
  // no timer of the worker is left behind
  await until(() => timeouts() <= before)
  assert.ok(timeouts() <= before, `${timeouts()} timers left, ${before} before`)
})

t('background refresh 0 scans once after the start and then only on events', async () => {
  main.TUNING.eventGapMs = 0
  main.TUNING.startDelayMs = 10
  main.TUNING.secondMs = 1
  const host = mockHost({ settings: { backgroundSeconds: 0 }, results: { 'workspace.list': list([]) } })
  await mount(host)
  await until(() => host.callsOf('workspace.list').length >= 1)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(host.callsOf('workspace.list').length, 1)
})

t('turning the background refresh on from the panel starts the timer', async () => {
  main.TUNING.eventGapMs = 0
  main.TUNING.secondMs = 1
  const host = mockHost({ settings: { backgroundSeconds: 0 }, results: { 'workspace.list': list([]) } })
  const worker = await mount(host)
  await worker.request('config.get')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(host.callsOf('workspace.list').length, 0)
  await worker.request('config.set', { backgroundSeconds: 30 })
  await until(() => host.callsOf('workspace.list').length >= 2)
  assert.ok(host.callsOf('workspace.list').length >= 2)
  await worker.request('config.set', { backgroundSeconds: 0 })
  await new Promise((r) => setTimeout(r, 60))
  const count = host.callsOf('workspace.list').length
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(host.callsOf('workspace.list').length, count)
})

t('a background tick never starts a second scan next to a running one', async () => {
  main.TUNING.eventGapMs = 0
  main.TUNING.startDelayMs = 5
  main.TUNING.secondMs = 1
  const dir = await repo()
  // listing takes 100 ms, ticks come every 30 ms: overlapping scans would list at the same time
  let active = 0
  let most = 0
  const host = mockHost({
    settings: { backgroundSeconds: 30 },
    results: {
      'workspace.list': async () => {
        active++
        most = Math.max(most, active)
        await new Promise((r) => setTimeout(r, 100))
        active--
        return list([ws('w1', dir)])
      }
    }
  })
  const worker = await mount(host)
  await until(() => host.callsOf('workspace.list').length >= 3)
  // events and the panel on top of it
  await worker.emit('agent.status.changed', event('w1', 'working'))
  await worker.request('sessions.refresh')
  await until(() => host.callsOf('workspace.list').length >= 5)
  assert.ok(host.callsOf('workspace.list').length >= 5)
  assert.equal(most, 1)
})

// Notification when an agent finishes

/** Agent works and finishes in w1, then the worker settles (the refresh waits for a running scan) */
async function agentRun(worker: Worker, id = 'w1'): Promise<void> {
  await worker.emit('agent.status.changed', event(id, 'working'))
  await worker.emit('agent.status.changed', event(id, 'done'))
  await worker.request('sessions.refresh')
}

t('a finished agent that leaves uncommitted files is notified after a fresh rescan, without the panel', async () => {
  main.TUNING.eventGapMs = 20
  const dir = await repo()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir, { name: 'checkout' })]) } })
  const worker = await mount(host)
  await worker.emit('agent.status.changed', event('w1', 'working'))
  await until(() => host.callsOf('workspace.list').length >= 1)
  // the agent changes a file and stops
  await writeFile(join(dir, 'a.txt'), 'changed by the agent\n')
  await worker.emit('agent.status.changed', event('w1', 'done'))
  await until(() => notes(host).length >= 1)
  assert.deepEqual(notes(host), [{ title: 'Session Check', body: 'acme-shop / checkout: agent finished, 1 file uncommitted' }])
  assert.ok(!notes(host)[0].body.includes('a.txt'))
  assert.deepEqual(worker.refusals, [])
})

t('unpushed commits and new files are named too', async () => {
  const { dir } = await withRemote()
  await writeFile(join(dir, 'b.txt'), 'b\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'agent commit')
  await writeFile(join(dir, 'c.txt'), 'new\n')
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir, { branch: 'main' })]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await agentRun(worker)
  assert.deepEqual(notes(host).map((n) => n.body), ['acme-shop / w1: agent finished, 1 new file, 1 commit unpushed'])
})

t('no notification for a clean worktree', async () => {
  const { dir } = await withRemote()
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir, { branch: 'main' })]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await agentRun(worker)
  assert.deepEqual(notes(host), [])
})

t('at most one notification per worktree in 10 minutes', async () => {
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', await repo(true)), ws('w2', await repo(true))]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await agentRun(worker)
  await agentRun(worker)
  assert.equal(notes(host).length, 1)
  // another worktree has its own limit
  await agentRun(worker, 'w2')
  assert.equal(notes(host).length, 2)
  // the gap is what holds the second one back
  main.TUNING.notifyGapMs = 0
  await agentRun(worker)
  assert.equal(notes(host).length, 3)
})

t('no notification for a hidden worktree', async () => {
  const host = mockHost({ storage: { hidden: { w1: 'keep' } }, results: { 'workspace.list': list([ws('w1', await repo(true))]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await agentRun(worker)
  assert.deepEqual(notes(host), [])
})

t('notifyOnAgentDone false turns the notification off', async () => {
  const host = mockHost({ settings: { notifyOnAgentDone: false }, results: { 'workspace.list': list([ws('w1', await repo(true))]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await agentRun(worker)
  assert.deepEqual(notes(host), [])
  await worker.request('config.set', { notifyOnAgentDone: true })
  await agentRun(worker)
  assert.equal(notes(host).length, 1)
})

t('only working or blocked to done counts as finished', async () => {
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', await repo(true))]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  // a done without a known start, and waiting to done
  await worker.emit('agent.status.changed', event('w1', 'done'))
  await worker.emit('agent.status.changed', event('w1', 'waiting'))
  await worker.emit('agent.status.changed', event('w1', 'done'))
  await worker.request('sessions.refresh')
  assert.deepEqual(notes(host), [])
  await worker.emit('agent.status.changed', event('w1', 'blocked'))
  await worker.emit('agent.status.changed', event('w1', 'done'))
  await worker.request('sessions.refresh')
  assert.equal(notes(host).length, 1)
})

t('names in the notification are cleaned and cut', async () => {
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', await repo(true), { name: 'ok‮evil\n', project: 'p'.repeat(100) })]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await agentRun(worker)
  const body = notes(host)[0]?.body ?? ''
  assert.equal(body, `${'p'.repeat(39)}… / ok?evil?: agent finished, 1 file uncommitted`)
  assert.ok(!/[\u0000-\u001f‪-‮⁦-⁩]/.test(body))
})

t('a failed notification is logged, not thrown', async () => {
  const host = mockHost({ capabilities: ['workspace:read', 'workspace:write', 'agent:read', 'storage:own', 'settings:own'], results: { 'workspace.list': list([ws('w1', await repo(true))]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await agentRun(worker)
  assert.ok(worker.logs.some((l) => l.startsWith('notify failed')))
  assert.equal(worker.refusals.length, 1)
})

// Languages: the status bar and the notification are made in the worker

t('the language setting is validated: unknown values are auto, only known ones are stored', async () => {
  const host = mockHost({ results: { 'workspace.list': list([]) }, settings: { language: 'klingon' } })
  const worker = await mount(host)
  assert.equal(((await worker.request('config.get')) as { language: string }).language, 'auto')
  assert.equal(((await worker.request('config.set', { language: 'de' })) as { language: string }).language, 'de')
  assert.equal(host.data().settings.language, 'de')
  for (const bad of ['fr', 'DE', '', 5, null]) {
    assert.equal(((await worker.request('config.set', { language: bad as never })) as { language: string }).language, 'de')
  }
  assert.equal(host.data().settings.language, 'de')
  await worker.request('config.set', { language: 'auto' })
  assert.equal(host.data().settings.language, 'auto')
})

t('the status bar and its tooltip in German when the setting says de', async () => {
  const host = mockHost({ settings: { language: 'de' }, results: { 'workspace.list': list([ws('w1', await dirtyRepo(2), { name: 'checkout' }), ws('w2', await repo())]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  assert.deepEqual(bar(host), { id: 'sessions', text: 'Sessions 1 offen', tone: 'warning', tooltip: 'Nicht committete Dateien: acme-shop / checkout (2)' })
  assert.equal(await worker.command('refresh'), '2 Worktrees')
})

t('auto follows the locale the panel tells, the status bar changes at once', async () => {
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', await repo())]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  assert.equal(bar(host)?.text, 'Sessions ok')
  assert.deepEqual(await worker.request('ui.locale', { locale: 'es-MX' }), { ok: true })
  await until(() => bar(host)?.text === 'Sesiones ok')
  assert.deepEqual(bar(host), { id: 'sessions', text: 'Sesiones ok', tone: 'success', tooltip: 'Session Check: todos los worktrees están confirmados' })
  // an explicit setting wins over the locale
  await worker.request('config.set', { language: 'de' })
  await until(() => bar(host)?.text === 'Sessions ok' && bar(host)?.tooltip.includes('alle Worktrees') === true)
  assert.equal(bar(host)?.tooltip, 'Session Check: alle Worktrees sind committet')
  // a locale Orca might send that is none of the three: English
  await worker.request('config.set', { language: 'auto' })
  await worker.request('ui.locale', { locale: 'fr-FR' })
  await until(() => bar(host)?.tooltip === 'Session Check: every worktree is committed')
  assert.equal(bar(host)?.tooltip, 'Session Check: every worktree is committed')
})

t('without a locale from the panel the system locale counts, the panel one wins', async () => {
  main.LOCALE.system = () => 'de-AT'
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', await repo(), { status: status('working') })]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  assert.equal(bar(host)?.tooltip, 'Session Check: alle Worktrees sind committet')
  await worker.request('ui.locale', { locale: 'en-US' })
  await until(() => bar(host)?.tooltip === 'Session Check: every worktree is committed')
  assert.equal(bar(host)?.tooltip, 'Session Check: every worktree is committed')
})

t('a system locale that cannot be read means English', async () => {
  main.LOCALE.system = () => {
    throw new Error('no Intl')
  }
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', await repo())]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  assert.equal(bar(host)?.text, 'Sessions ok')
})

t('ui.locale only takes a BCP-47 tag', async () => {
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', await repo())]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  for (const bad of [5, '', 'de DE', 'x'.repeat(80), '<script>', null]) {
    await assert.rejects(() => worker.request('ui.locale', { locale: bad as never }), /Invalid request/)
  }
  assert.equal(bar(host)?.text, 'Sessions ok')
})

t('the notification in German and in Spanish', async () => {
  const host = mockHost({ settings: { language: 'de' }, results: { 'workspace.list': list([ws('w1', await repo(true), { name: 'checkout' })]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await agentRun(worker)
  assert.deepEqual(notes(host), [{ title: 'Session Check', body: 'acme-shop / checkout: Agent fertig, 1 Datei nicht committet' }])
  // one worker at a time: deactivate() stops the worker that was mounted last
  await worker.deactivate()
  const { dir } = await withRemote()
  await writeFile(join(dir, 'b.txt'), 'b\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'agent commit')
  await writeFile(join(dir, 'c.txt'), 'new\n')
  await writeFile(join(dir, 'd.txt'), 'new\n')
  const es = mockHost({ settings: { language: 'es' }, results: { 'workspace.list': list([ws('w1', dir, { branch: 'main' })]) } })
  const w2 = await mount(es)
  await w2.request('sessions.get')
  await agentRun(w2)
  assert.deepEqual(notes(es).map((n) => n.body), ['acme-shop / w1: agente terminado, 2 archivos nuevos, 1 commit sin push'])
})

t('errors reach the panel with a message code, the text stays English', async () => {
  const host = mockHost({ results: { 'workspace.list': list([ws('gone', '/nonexistent-acme-path'), ws('folder', '/tmp', { kind: 'folder', branch: null })]) } })
  const worker = await mount(host)
  const s = (await worker.request('sessions.get')) as SessionsState
  const by = Object.fromEntries(s.sessions.map((x) => [x.id, x]))
  assert.equal(by.gone.error, 'folder not found')
  assert.equal(by.gone.errorCode, 'err.folderNotFound')
  assert.equal(by.folder.errorCode, 'err.folderWorkspace')
})

// Files that must not be committed

t('a new .env keeps the worktree and is listed; the warning off reports nothing', async () => {
  const dir = await repo()
  await writeFile(join(dir, '.env'), 'X=1\n')
  const host = mockHost({ settings: { warnSensitive: false }, results: { 'workspace.list': list([ws('w1', dir)]) } })
  const worker = await mount(host)
  const off = ((await worker.request('sessions.get')) as SessionsState).sessions[0]
  assert.deepEqual([off.verdict, off.sensitive, off.sensitiveCount, off.sensitiveSecrets, off.sensitiveTracked], ['check', [], 0, 0, 0])
  assert.ok(!off.reasons.some((r) => r.includes('sensitive')))
  // switched on from the panel: the verdict changes at once, without reading git again
  const scans = host.callsOf('workspace.list').length
  const cfg = (await worker.request('config.set', { warnSensitive: true })) as { warnSensitive: boolean }
  assert.equal(cfg.warnSensitive, true)
  assert.equal(host.data().settings.warnSensitive, true)
  const on = sessionOf(worker, 'w1')
  assert.equal(on?.verdict, 'keep')
  assert.deepEqual(on?.sensitive, [{ path: '.env', kind: 'secret', tracked: false, rule: '.env' }])
  assert.equal(on?.sensitiveCount, 1)
  assert.ok(on?.reasons.includes('1 sensitive file not ignored'))
  assert.equal(host.callsOf('workspace.list').length, scans)
  // a value that is not a boolean is ignored
  await worker.request('config.set', { warnSensitive: 'no' as never })
  assert.equal(((await worker.request('config.get')) as { warnSensitive: boolean }).warnSensitive, true)
  await worker.request('config.set', { warnSensitive: false })
  assert.equal(sessionOf(worker, 'w1')?.verdict, 'check')
  assert.deepEqual(sessionOf(worker, 'w1')?.sensitive, [])
})

t('a hidden worktree comes back when a secret appears, and one with a secret cannot be hidden', async () => {
  const { dir } = await withRemote()
  await writeFile(join(dir, 'notes.txt'), 'n\n')
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir, { branch: 'main' })]) } })
  const worker = await mount(host)
  assert.equal(((await worker.request('sessions.get')) as SessionsState).sessions[0].verdict, 'check')
  await worker.request('session.hide', { id: 'w1', hidden: true })
  assert.deepEqual(host.data().storage.hidden, { w1: 'check' })
  // still only yellow: stays hidden
  await writeFile(join(dir, 'more.txt'), 'm\n')
  assert.equal(((await worker.request('sessions.refresh')) as SessionsState).sessions[0].hidden, true)
  await writeFile(join(dir, 'id_rsa'), 'k\n')
  const s = ((await worker.request('sessions.refresh')) as SessionsState).sessions[0]
  assert.equal(s.verdict, 'keep')
  assert.equal(s.hidden, false)
  assert.deepEqual(host.data().storage.hidden, {})
  await assert.rejects(() => worker.request('session.hide', { id: 'w1', hidden: true }), /open work/)
})

t('a tracked secret asks for a look but does not keep an otherwise clean worktree open', async () => {
  const { dir } = await withRemote()
  await writeFile(join(dir, 'credentials.json'), '{}\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'creds')
  git(dir, 'push', '-q')
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir, { branch: 'main' })]) } })
  const worker = await mount(host)
  const s = ((await worker.request('sessions.get')) as SessionsState).sessions[0]
  assert.equal(s.verdict, 'check')
  assert.deepEqual(s.reasons, ['1 secret in repo'])
  assert.deepEqual([s.sensitiveTracked, s.sensitive[0]?.tracked], [1, true])
})

t('the notification adds the number of sensitive files, not when the warning is off', async () => {
  const dir = await repo()
  await writeFile(join(dir, '.env.local'), 'X=1\n')
  const host = mockHost({ results: { 'workspace.list': list([ws('w1', dir, { name: 'checkout' })]) } })
  const worker = await mount(host)
  await worker.request('sessions.get')
  await agentRun(worker)
  assert.deepEqual(notes(host).map((n) => n.body), ['acme-shop / checkout: agent finished, 1 new file, 1 sensitive file'])
  assert.ok(!notes(host)[0].body.includes('.env'))
  main.TUNING.notifyGapMs = 0
  await worker.request('config.set', { warnSensitive: false })
  await agentRun(worker)
  assert.equal(notes(host).at(-1)?.body, 'acme-shop / checkout: agent finished, 1 new file')
})
