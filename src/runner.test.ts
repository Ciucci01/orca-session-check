import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { GitError, gitEnv, mapLimit, runGit, scanRepo, type RepoState } from './runner'

// Real temporary repositories. Everything is removed again, even when an assertion fails.
const dirs: string[] = []
async function tmp(name = 'sc-'): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), name))
  dirs.push(d)
  return d
}
function t(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    const path = process.env.PATH
    try {
      await fn()
    } finally {
      process.env.PATH = path
      for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => undefined)
    }
  })
}

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=a@acme.test', '-c', 'user.name=acme', '-c', 'protocol.file.allow=always', ...args], { cwd, env: ENV, encoding: 'utf8' })
}
async function repo(name = 'acme-'): Promise<string> {
  const d = await tmp(name)
  git(d, 'init', '-q', '-b', 'main')
  await writeFile(join(d, 'a.txt'), 'a\n')
  git(d, 'add', '.')
  git(d, 'commit', '-q', '-m', 'init')
  return d
}
/** A repository with a bare "remote" so there is an upstream */
async function withRemote(): Promise<{ dir: string; remote: string }> {
  const remote = await tmp('acme-remote-')
  git(remote, 'init', '-q', '--bare', '-b', 'main')
  const dir = await repo()
  git(dir, 'remote', 'add', 'origin', remote)
  git(dir, 'push', '-q', '-u', 'origin', 'main')
  git(dir, 'remote', 'set-head', 'origin', 'main')
  return { dir, remote }
}
const ok = (r: Awaited<ReturnType<typeof scanRepo>>): RepoState => {
  assert.ok(!('error' in r), 'error' in r ? r.error : '')
  return r as RepoState
}

t('clean repository with upstream', async () => {
  const { dir } = await withRemote()
  const s = ok(await scanRepo(dir, ''))
  assert.deepEqual([s.head, s.upstream, s.ahead, s.behind, s.uncommitted, s.untracked, s.stash, s.operation], ['main', 'origin/main', 0, 0, 0, 0, 0, null])
})

t('modified, staged, untracked and renamed files', async () => {
  const dir = await repo()
  await writeFile(join(dir, 'b.txt'), 'b\n')
  git(dir, 'add', 'b.txt')
  git(dir, 'commit', '-q', '-m', 'b')
  await writeFile(join(dir, 'a.txt'), 'changed\n')
  await writeFile(join(dir, 'ä ö.txt'), 'x\n')
  git(dir, 'mv', 'b.txt', 'c d.txt')
  const s = ok(await scanRepo(dir, ''))
  assert.equal(s.uncommitted, 2)
  assert.equal(s.staged, 1)
  assert.equal(s.untracked, 1)
  assert.deepEqual(s.files.map((f) => f.path).sort(), ['a.txt', 'c d.txt', 'ä ö.txt'])
})

t('unpushed commits and behind', async () => {
  const { dir, remote } = await withRemote()
  await writeFile(join(dir, 'l.txt'), 'l\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'local')
  const other = await tmp('acme-other-')
  git(other, 'clone', '-q', remote, 'c')
  const c = join(other, 'c')
  await writeFile(join(c, 'o.txt'), 'o\n')
  git(c, 'add', '.')
  git(c, 'commit', '-q', '-m', 'other')
  git(c, 'push', '-q')
  git(dir, 'fetch', '-q')
  const s = ok(await scanRepo(dir, ''))
  assert.deepEqual([s.ahead, s.behind], [1, 1])
  assert.equal(s.merged, false)
})

t('a branch without upstream whose commits are in the base branch is merged', async () => {
  const { dir } = await withRemote()
  git(dir, 'checkout', '-q', '-b', 'feat/done')
  const s = ok(await scanRepo(dir, ''))
  assert.equal(s.upstream, null)
  assert.equal(s.merged, true)
})

t('a branch without upstream and with its own commit is not merged', async () => {
  const { dir } = await withRemote()
  git(dir, 'checkout', '-q', '-b', 'feat/work')
  await writeFile(join(dir, 'w.txt'), 'w\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'work')
  assert.equal(ok(await scanRepo(dir, '')).merged, false)
})

t('no base branch at all: merged stays unknown', async () => {
  const dir = await repo()
  git(dir, 'checkout', '-q', '-b', 'feat')
  assert.equal(ok(await scanRepo(dir, '')).merged, null)
})

t('the base branch setting is used', async () => {
  const dir = await repo()
  git(dir, 'branch', 'trunk')
  git(dir, 'checkout', '-q', '-b', 'feat')
  assert.equal(ok(await scanRepo(dir, '')).merged, null)
  git(dir, 'update-ref', 'refs/remotes/origin/trunk', 'trunk')
  assert.equal(ok(await scanRepo(dir, 'origin/trunk')).merged, true)
  // an unsafe setting is ignored, not passed to git
  assert.equal(ok(await scanRepo(dir, '--upload-pack=x')).merged, null)
})

t('a repository without commits', async () => {
  const d = await tmp()
  git(d, 'init', '-q', '-b', 'main')
  await writeFile(join(d, 'x.txt'), 'x\n')
  const s = ok(await scanRepo(d, ''))
  assert.equal(s.merged, true)
  assert.equal(s.untracked, 1)
})

t('stash is counted for its own branch only', async () => {
  const dir = await repo()
  await writeFile(join(dir, 'a.txt'), 'wip\n')
  git(dir, 'stash', '-q')
  git(dir, 'checkout', '-q', '-b', 'feat')
  await writeFile(join(dir, 'a.txt'), 'wip2\n')
  git(dir, 'stash', '-q')
  const feat = ok(await scanRepo(dir, ''))
  assert.deepEqual([feat.stash, feat.stashTotal], [1, 2])
  git(dir, 'checkout', '-q', 'main')
  assert.equal(ok(await scanRepo(dir, '')).stash, 1)
})

t('detached HEAD', async () => {
  const dir = await repo()
  git(dir, 'checkout', '-q', '--detach')
  const s = ok(await scanRepo(dir, ''))
  assert.equal(s.detached, true)
  assert.equal(s.head, null)
})

t('merge conflict and the merge marker', async () => {
  const dir = await repo()
  git(dir, 'checkout', '-q', '-b', 'other')
  await writeFile(join(dir, 'a.txt'), 'other\n')
  git(dir, 'commit', '-q', '-am', 'other')
  git(dir, 'checkout', '-q', 'main')
  await writeFile(join(dir, 'a.txt'), 'main\n')
  git(dir, 'commit', '-q', '-am', 'main')
  try {
    git(dir, 'merge', 'other')
  } catch {
    // the conflict is the point
  }
  const s = ok(await scanRepo(dir, ''))
  assert.equal(s.operation, 'merge')
  assert.equal(s.conflicts, 1)
})

t('a rebase in progress is found', async () => {
  const dir = await repo()
  git(dir, 'checkout', '-q', '-b', 'other')
  await writeFile(join(dir, 'a.txt'), 'other\n')
  git(dir, 'commit', '-q', '-am', 'other')
  git(dir, 'checkout', '-q', 'main')
  await writeFile(join(dir, 'a.txt'), 'main\n')
  git(dir, 'commit', '-q', '-am', 'main')
  git(dir, 'checkout', '-q', 'other')
  try {
    git(dir, 'rebase', 'main')
  } catch {
    // stops on the conflict
  }
  assert.equal(ok(await scanRepo(dir, '')).operation, 'rebase')
})

t('a linked worktree has its own git dir and marker', async () => {
  const dir = await repo()
  const wt = join(await tmp('acme-wt-'), 'tree')
  git(dir, 'worktree', 'add', '-q', '-b', 'wt', wt)
  await writeFile(join(wt, 'n.txt'), 'n\n')
  git(wt, 'add', '.')
  git(wt, 'commit', '-q', '-m', 'n')
  git(wt, 'checkout', '-q', '-b', 'tmp', 'HEAD~1')
  await writeFile(join(wt, 'n.txt'), 'conflict\n')
  git(wt, 'add', '.')
  git(wt, 'commit', '-q', '-m', 'c')
  try {
    git(wt, 'merge', 'wt')
  } catch {
    // conflict
  }
  assert.equal(ok(await scanRepo(wt, '')).operation, 'merge')
  assert.equal(ok(await scanRepo(dir, '')).operation, null)
})

t('not a git repository, missing folder, plain file', async () => {
  const plain = await tmp()
  assert.deepEqual(await scanRepo(plain, ''), { error: 'not a git repository (or git refused it)' })
  assert.deepEqual(await scanRepo(join(plain, 'nope'), ''), { error: 'folder not found' })
  await writeFile(join(plain, 'f'), '')
  assert.deepEqual(await scanRepo(join(plain, 'f'), ''), { error: 'folder not found' })
})

t('invalid paths never reach git', async () => {
  for (const bad of ['relative', '-C', '', '/x\0y']) assert.deepEqual(await scanRepo(bad, ''), { error: 'invalid path' })
  await assert.rejects(() => runGit('relative', [], ['status']))
})

t('a path with spaces, quotes and $() works and runs nothing', async () => {
  const base = await tmp()
  const evil = join(base, `a b'"$(touch PWNED) \`touch PWNED2\` ; touch PWNED3`)
  await mkdir(evil)
  git(evil, 'init', '-q', '-b', 'main')
  await writeFile(join(evil, 'f.txt'), 'f\n')
  const s = ok(await scanRepo(evil, ''))
  assert.equal(s.untracked, 1)
  for (const where of [base, evil, process.cwd()]) {
    for (const name of ['PWNED', 'PWNED2', 'PWNED3']) await assert.rejects(() => access(join(where, name)))
  }
})

t('a workspace that is a symlink to a repository is scanned', async () => {
  const dir = await repo()
  const link = join(await tmp('acme-link-'), 'ws')
  await symlink(dir, link)
  assert.equal(ok(await scanRepo(link, '')).head, 'main')
})

// --- Security: a repository must not run programs ---------------------------------------

async function marker(passThrough = true): Promise<{ script: string; mark: string; ran(): Promise<boolean> }> {
  const d = await tmp('acme-mark-')
  const mark = join(d, 'MARK')
  const script = join(d, 'run.sh')
  // filters read their input; commands that git starts for a fetch must end by themselves
  await writeFile(script, `#!/bin/sh\ntouch '${mark}'\n${passThrough ? 'cat\n' : ''}`)
  await chmod(script, 0o755)
  return { script, mark, ran: () => access(mark).then(() => true, () => false) }
}
/** What happens without the protection: the same call with plain git */
function plainStatus(dir: string): void {
  try {
    execFileSync('git', ['-C', dir, 'status', '--porcelain=v2', '-z'], { env: ENV, stdio: 'ignore' })
  } catch {
    // the exit code does not matter, only whether the program ran
  }
}

t('core.fsmonitor in .git/config does not run (and does run without the protection)', async () => {
  const dir = await repo()
  const m = await marker()
  git(dir, 'config', 'core.fsmonitor', m.script)
  await scanRepo(dir, '')
  assert.equal(await m.ran(), false, 'scan ran fsmonitor')
  plainStatus(dir)
  assert.equal(await m.ran(), true, 'control: plain git must run it, or this test proves nothing')
})

t('core.fsmonitor via include.path does not run', async () => {
  const dir = await repo()
  const m = await marker()
  const inc = join(await tmp('acme-inc-'), 'evil.inc')
  await writeFile(inc, `[core]\n\tfsmonitor = ${m.script}\n`)
  git(dir, 'config', 'include.path', inc)
  await scanRepo(dir, '')
  assert.equal(await m.ran(), false)
  plainStatus(dir)
  assert.equal(await m.ran(), true, 'control')
})

t('core.fsmonitor in the worktree config does not run', async () => {
  const dir = await repo()
  const m = await marker()
  git(dir, 'config', 'extensions.worktreeConfig', 'true')
  git(dir, 'config', '--worktree', 'core.fsmonitor', m.script)
  await scanRepo(dir, '')
  assert.equal(await m.ran(), false)
  plainStatus(dir)
  assert.equal(await m.ran(), true, 'control')
})

async function filterRepo(attributesIn: 'tree' | 'info', property: 'clean' | 'process'): Promise<{ dir: string; m: Awaited<ReturnType<typeof marker>> }> {
  const dir = await tmp('acme-filter-')
  git(dir, 'init', '-q', '-b', 'main')
  if (attributesIn === 'tree') await writeFile(join(dir, '.gitattributes'), '*.txt filter=evil\n')
  else await writeFile(join(dir, '.git', 'info', 'attributes'), '*.txt filter=evil\n')
  await writeFile(join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  const m = await marker()
  git(dir, 'config', `filter.evil.${property}`, m.script)
  // same size, new time stamp: git has to hash the file again and would run the filter
  await writeFile(join(dir, 'a.txt'), 'b\n')
  const later = new Date(Date.now() + 5000)
  const { utimes } = await import('node:fs/promises')
  await utimes(join(dir, 'a.txt'), later, later)
  return { dir, m }
}
for (const where of ['tree', 'info'] as const) {
  for (const prop of ['clean', 'process'] as const) {
    t(`filter.${prop} (attributes in ${where}) does not run (and does run without the protection)`, async () => {
      const { dir, m } = await filterRepo(where, prop)
      const s = ok(await scanRepo(dir, ''))
      assert.equal(await m.ran(), false, 'scan ran the filter')
      assert.equal(s.uncommitted, 1)
      plainStatus(dir)
      assert.equal(await m.ran(), true, 'control: plain git must run it, or this test proves nothing')
    })
  }
}

t('a required filter does not break the scan', async () => {
  const { dir } = await filterRepo('tree', 'clean')
  git(dir, 'config', 'filter.evil.required', 'true')
  assert.equal(ok(await scanRepo(dir, '')).uncommitted, 1)
})

t('other config programs (pager, ssh, askpass, diff.external, textconv) do not run during a scan', async () => {
  const dir = await repo()
  const m = await marker()
  for (const k of ['core.pager', 'core.editor', 'core.sshCommand', 'core.askPass', 'diff.external', 'credential.helper', 'core.gitProxy']) git(dir, 'config', k, m.script)
  await writeFile(join(dir, '.gitattributes'), '*.txt diff=evil\n')
  git(dir, 'config', 'diff.evil.textconv', m.script)
  await writeFile(join(dir, 'a.txt'), 'changed\n')
  ok(await scanRepo(dir, ''))
  assert.equal(await m.ran(), false)
})

t('hooks are not run', async () => {
  const dir = await repo()
  const m = await marker()
  await writeFile(join(dir, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\ntouch '${m.mark}'\n`)
  await chmod(join(dir, '.git', 'hooks', 'post-index-change'), 0o755)
  await writeFile(join(dir, 'a.txt'), 'changed\n')
  ok(await scanRepo(dir, ''))
  assert.equal(await m.ran(), false)
})

t('the scan does not write: no index.lock, index unchanged', async () => {
  const dir = await repo()
  const { stat } = await import('node:fs/promises')
  const before = (await stat(join(dir, '.git', 'index'))).mtimeMs
  await writeFile(join(dir, 'a.txt'), 'changed\n')
  ok(await scanRepo(dir, ''))
  assert.equal((await stat(join(dir, '.git', 'index'))).mtimeMs, before)
  await assert.rejects(() => access(join(dir, '.git', 'index.lock')))
})

t('the environment passed to git is a short list', async () => {
  const env = gitEnv({ PATH: '/bin', HOME: '/h', GIT_EXTERNAL_DIFF: 'x', GIT_PAGER: 'x', GIT_DIR: '/x', GIT_SSH_COMMAND: 'x', GIT_CONFIG_COUNT: '1', EDITOR: 'x', SECRET_TOKEN: 's' })
  assert.deepEqual(Object.keys(env).sort(), ['GIT_NO_LAZY_FETCH', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'HOME', 'LC_ALL', 'PATH'])
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
})

// --- Limits: timeout, output size, missing git, parallel jobs ---------------------------

async function fakeGit(body: string): Promise<void> {
  const d = await tmp('acme-fakegit-')
  await writeFile(join(d, 'git'), `#!/bin/sh\n${body}\n`)
  await chmod(join(d, 'git'), 0o755)
  process.env.PATH = d
}

t('a hanging git is stopped by the timeout', async () => {
  await fakeGit('exec /bin/sleep 5')
  const started = Date.now()
  await assert.rejects(() => runGit('/tmp', [], ['status'], 150), (e: unknown) => e instanceof GitError && e.reason === 'timeout')
  assert.ok(Date.now() - started < 3000)
})

t('huge output is cut off', async () => {
  await fakeGit('exec /usr/bin/head -c 3000000 /dev/zero')
  await assert.rejects(() => runGit('/tmp', [], ['status']), (e: unknown) => e instanceof GitError && e.reason === 'too-large')
})

t('missing git gives a clear error, not a crash', async () => {
  const empty = await tmp('acme-nogit-')
  const dir = await repo()
  process.env.PATH = empty
  assert.deepEqual(await scanRepo(dir, ''), { error: 'git is not installed' })
})

t('mapLimit never runs more jobs than allowed and keeps the order', async () => {
  let running = 0
  let peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (n) => {
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 10))
    running--
    return n * 2
  })
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
  assert.equal(peak, 4)
  assert.deepEqual(await mapLimit([], 4, async (n) => n), [])
})

t('the time of the last commit is read, none for a repository without commits', async () => {
  const dir = await repo()
  const s = ok(await scanRepo(dir, ''))
  assert.ok(s.lastCommitAt !== null && Math.abs(Date.now() - s.lastCommitAt) < 60_000)
  const empty = await tmp()
  git(empty, 'init', '-q', '-b', 'main')
  assert.equal(ok(await scanRepo(empty, '')).lastCommitAt, null)
})

t('size, age and the unpushed commits of open work are read', async () => {
  const { dir } = await withRemote()
  await writeFile(join(dir, 'l.txt'), 'l\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'add l')
  await writeFile(join(dir, 'm.txt'), 'm\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'add m\u001b[31m')
  await writeFile(join(dir, 'a.txt'), 'a\nsecond\nthird\n')
  const s = ok(await scanRepo(dir, ''))
  assert.deepEqual([s.added, s.removed], [2, 0])
  assert.deepEqual(s.unpushed, ['add m?[31m', 'add l'])
  assert.ok(s.dirtySince !== null && Math.abs(Date.now() - s.dirtySince) < 60_000)
})

t('the oldest change counts, a deleted file does not break it', async () => {
  const dir = await repo()
  const { utimes } = await import('node:fs/promises')
  await writeFile(join(dir, 'b.txt'), 'b\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'b')
  await writeFile(join(dir, 'a.txt'), 'changed\n')
  const old = new Date(Date.now() - 9 * 86_400_000)
  await utimes(join(dir, 'a.txt'), old, old)
  await rm(join(dir, 'b.txt'))
  const s = ok(await scanRepo(dir, ''))
  assert.equal(s.uncommitted, 2)
  assert.ok(s.dirtySince !== null && Math.abs(s.dirtySince - old.getTime()) < 2000)
})

t('a clean repository has no size, age or unpushed list', async () => {
  const { dir } = await withRemote()
  const s = ok(await scanRepo(dir, ''))
  assert.deepEqual([s.added, s.removed, s.dirtySince, s.unpushed], [null, null, null, []])
})

t('textconv and external diff of the repository do not run for the size', async () => {
  const dir = await repo()
  const m = await marker()
  await writeFile(join(dir, '.gitattributes'), '*.txt diff=evil\n')
  git(dir, 'config', 'diff.evil.textconv', m.script)
  git(dir, 'config', 'diff.external', m.script)
  await writeFile(join(dir, 'a.txt'), 'changed\n')
  const s = ok(await scanRepo(dir, ''))
  assert.equal(await m.ran(), false)
  assert.deepEqual([s.added, s.removed], [1, 1])
})

t('a symlink among the changes is not followed for its age', async () => {
  const dir = await repo()
  const target = await tmp('acme-target-')
  await symlink(target, join(dir, 'link'))
  git(dir, 'add', 'link')
  git(dir, 'commit', '-q', '-m', 'link')
  await rm(join(dir, 'link'))
  await writeFile(join(dir, 'link'), 'now a file\n')
  assert.equal(ok(await scanRepo(dir, '')).uncommitted, 1)
})

// --- Findings of the security review ---------------------------------------------------

t('log.showSignature with a gpg.program of the repository does not run it', async () => {
  const dir = await repo()
  const m = await marker(false)
  git(dir, 'config', 'log.showSignature', 'true')
  git(dir, 'config', 'gpg.program', m.script)
  // a commit with a signature header that gpg is asked to verify
  const tree = git(dir, 'rev-parse', 'HEAD^{tree}').trim()
  const parent = git(dir, 'rev-parse', 'HEAD').trim()
  const raw = `tree ${tree}\nparent ${parent}\nauthor a <a@acme.test> 1700000000 +0000\ncommitter a <a@acme.test> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----\n\nsigned\n`
  const file = join(await tmp('acme-raw-'), 'commit')
  await writeFile(file, raw)
  const oid = git(dir, 'hash-object', '-t', 'commit', '-w', file).trim()
  git(dir, 'update-ref', 'refs/heads/main', oid)
  await writeFile(join(dir, 'a.txt'), 'changed\n')
  ok(await scanRepo(dir, ''))
  assert.equal(await m.ran(), false, 'scan ran gpg.program')
  // control: plain git log with the same config does run it
  try {
    execFileSync('git', ['-C', dir, 'log', '-1', '--format=%ct', 'HEAD'], { env: ENV, stdio: 'ignore' })
  } catch {
    // only the marker counts
  }
  assert.equal(await m.ran(), true, 'control')
})

t('a partial clone is not scanned (lazy fetch would start programs and use the network)', async () => {
  const dir = await repo()
  const m = await marker(false)
  git(dir, 'config', 'extensions.partialClone', 'origin')
  git(dir, 'config', 'remote.origin.promisor', 'true')
  git(dir, 'config', 'remote.origin.url', `ext::${m.script}`)
  git(dir, 'config', 'remote.origin.uploadpack', m.script)
  await writeFile(join(dir, 'a.txt'), 'changed\n')
  assert.deepEqual(await scanRepo(dir, ''), { error: 'partial clone, not checked' })
  assert.equal(await m.ran(), false)
})

t('a lazy fetch through the protocol flags is blocked even without the partial clone check', async () => {
  const dir = await repo()
  const remote = await tmp('acme-remote-')
  git(remote, 'init', '-q', '--bare', '-b', 'main')
  const m = await marker(false)
  git(dir, 'config', 'remote.origin.url', `file://${remote}`)
  git(dir, 'config', 'remote.origin.uploadpack', m.script)
  git(dir, 'config', 'protocol.file.allow', 'always')
  // a fetch with the flags: the protocol is refused before the program starts
  await runGit(dir, [], ['fetch', 'origin']).catch(() => undefined)
  assert.equal(await m.ran(), false, 'protocol.file.allow=never must beat the repository config')
  // control: without the flags the repository config starts the program
  try {
    execFileSync('git', ['-C', dir, 'fetch', 'origin'], { env: ENV, stdio: 'ignore' })
  } catch {
    // only the marker counts
  }
  assert.equal(await m.ran(), true, 'control')
})

t('submodules: their own config does not run and their presence is reported', async () => {
  const sub = await repo('acme-sub-')
  const dir = await repo()
  git(dir, 'config', 'protocol.file.allow', 'always')
  git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor')
  git(dir, 'commit', '-q', '-m', 'add submodule')
  const m = await marker()
  await writeFile(join(dir, 'a.txt'), 'changed\n')
  // the submodule's own config with a clean filter and a changed file inside it
  const gitdir = join(dir, '.git', 'modules', 'vendor')
  git(dir, 'config', '--file', join(gitdir, 'config'), 'filter.evil.clean', m.script)
  await writeFile(join(dir, 'vendor', '.gitattributes'), '*.txt filter=evil\n')
  await writeFile(join(dir, 'vendor', 'a.txt'), 'b\n')
  const later = new Date(Date.now() + 5000)
  const { utimes } = await import('node:fs/promises')
  await utimes(join(dir, 'vendor', 'a.txt'), later, later)
  const s = ok(await scanRepo(dir, ''))
  assert.equal(await m.ran(), false, 'a submodule filter ran')
  assert.equal(s.submodules, true)
  assert.equal(s.uncommitted, 1)
})

t('an upstream whose branch is gone is found and compared with the base branch', async () => {
  const { dir } = await withRemote()
  git(dir, 'checkout', '-q', '-b', 'feat')
  git(dir, 'push', '-q', '-u', 'origin', 'feat')
  await writeFile(join(dir, 'w.txt'), 'w\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'only here')
  git(dir, 'push', '-q', 'origin', '--delete', 'feat')
  git(dir, 'fetch', '-q', '--prune')
  const s = ok(await scanRepo(dir, ''))
  assert.equal(s.upstreamGone, true)
  assert.equal(s.merged, false)
})

t('a local branch named like the remote base branch does not count as the base', async () => {
  const { dir } = await withRemote()
  git(dir, 'checkout', '-q', '-b', 'feat')
  await writeFile(join(dir, 'w.txt'), 'w\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'work')
  // the ambiguous short name origin/main now points at HEAD
  git(dir, 'branch', 'origin/main')
  assert.equal(ok(await scanRepo(dir, '')).merged, false)
  // a base branch setting of "HEAD" never makes everything look merged
  assert.equal(ok(await scanRepo(dir, 'HEAD')).merged, false)
})

t('the age is read from the top of the worktree when the workspace is a subfolder', async () => {
  const dir = await repo()
  await mkdir(join(dir, 'sub'))
  await writeFile(join(dir, 'sub', 'z.txt'), 'z\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'z')
  await writeFile(join(dir, 'sub', 'z.txt'), 'changed\n')
  const s = ok(await scanRepo(join(dir, 'sub'), ''))
  assert.ok(s.dirtySince !== null)
})
