import { assert, test } from 'orca/testing'
import {
  baseCandidates, cleanPath, compareSessions, verdictRank, filterOverrides, gitArgs, GIT_FLAGS, isSafePath, isSafeRef,
  isSafeUpstream, operationFrom, parseCommitTime, parseShortstat, parseSubjects, parseStash, parseStatus, verdict, type VerdictInput
} from './git'

const z = (...parts: string[]) => parts.join('\0') + '\0'
const OID = '1'.repeat(40)
const head = (branch: string, extra: string[] = []) => ['# branch.oid ' + OID, '# branch.head ' + branch, ...extra]

test('status: clean branch with upstream', () => {
  const s = parseStatus(z(...head('main', ['# branch.upstream origin/main', '# branch.ab +0 -0'])))
  assert.equal(s.head, 'main')
  assert.equal(s.upstream, 'origin/main')
  assert.equal(s.hasAheadBehind, true)
  assert.deepEqual([s.ahead, s.behind, s.uncommitted, s.untracked, s.conflicts], [0, 0, 0, 0, 0])
})

test('status: ahead and behind', () => {
  const s = parseStatus(z(...head('feat', ['# branch.upstream origin/feat', '# branch.ab +2 -5'])))
  assert.deepEqual([s.ahead, s.behind], [2, 5])
})

test('status: no upstream has no branch.ab', () => {
  const s = parseStatus(z(...head('feat')))
  assert.equal(s.upstream, null)
  assert.equal(s.hasAheadBehind, false)
})

test('status: detached HEAD and unborn branch', () => {
  const d = parseStatus(z('# branch.oid ' + OID, '# branch.head (detached)'))
  assert.equal(d.detached, true)
  assert.equal(d.head, null)
  const u = parseStatus(z('# branch.oid (initial)', '# branch.head main'))
  assert.equal(u.oid, null)
  assert.equal(u.head, 'main')
})

test('status: changed, staged, both, untracked', () => {
  const h = 'a'.repeat(40)
  const e = (xy: string, p: string) => `1 ${xy} N... 100644 100644 100644 ${h} ${h} ${p}`
  const s = parseStatus(z(...head('main'), e('.M', 'a.txt'), e('M.', 'b.txt'), e('MM', 'c.txt'), '? new.txt'))
  assert.equal(s.uncommitted, 3)
  assert.equal(s.staged, 2)
  assert.equal(s.untracked, 1)
  assert.deepEqual(s.files.map((f) => [f.state, f.path]), [['.M', 'a.txt'], ['M.', 'b.txt'], ['MM', 'c.txt'], ['??', 'new.txt']])
})

test('status: rename takes the second path entry', () => {
  const h = 'a'.repeat(40)
  const s = parseStatus(z(...head('main'), `2 R. N... 100644 100644 100644 ${h} ${h} R100 new name.txt`, 'old name.txt', '? after.txt'))
  assert.equal(s.uncommitted, 1)
  assert.equal(s.untracked, 1)
  assert.deepEqual(s.files.map((f) => f.path), ['new name.txt', 'after.txt'])
})

test('status: conflict counts as uncommitted and as conflict', () => {
  const h = 'a'.repeat(40)
  const s = parseStatus(z(...head('main'), `u UU N... 100644 100644 100644 100644 ${h} ${h} ${h} c.txt`))
  assert.deepEqual([s.uncommitted, s.conflicts, s.staged], [1, 1, 0])
})

test('status: umlauts, spaces and a new line in a name', () => {
  const s = parseStatus(z(...head('main'), '? ä ö ü.txt', '? line\nbreak.txt'))
  assert.equal(s.files[0].path, 'ä ö ü.txt')
  assert.equal(s.files[1].path, 'line?break.txt')
})

test('status: at most 20 files, the rest is counted', () => {
  const entries = Array.from({ length: 27 }, (_, i) => `? f${i}.txt`)
  const s = parseStatus(z(...head('main'), ...entries))
  assert.equal(s.files.length, 20)
  assert.equal(s.moreFiles, 7)
  assert.equal(s.untracked, 27)
})

test('cleanPath cuts control characters and long names', () => {
  assert.equal(cleanPath('a\u0000b\u001bc'), 'a?b?c')
  assert.equal(cleanPath('x'.repeat(400)).length, 301)
})

test('stash: counted per branch and in total', () => {
  const s = parseStash('WIP on main: abc1234 msg\nOn feat/x: my note\nWIP on (no branch): abc1234 msg\nWIP on main: def5678 other\n')
  assert.equal(s.total, 4)
  assert.equal(s.byBranch.get('main'), 2)
  assert.equal(s.byBranch.get('feat/x'), 1)
  assert.equal(s.byBranch.get('(no branch)'), 1)
  assert.equal(parseStash('').total, 0)
})

test('operation markers', () => {
  assert.equal(operationFrom(['HEAD', 'config']), null)
  assert.equal(operationFrom(['MERGE_HEAD']), 'merge')
  assert.equal(operationFrom(['rebase-merge']), 'rebase')
  assert.equal(operationFrom(['rebase-apply']), 'rebase')
  assert.equal(operationFrom(['CHERRY_PICK_HEAD']), 'cherry-pick')
  assert.equal(operationFrom(['REVERT_HEAD']), 'revert')
  assert.equal(operationFrom(['BISECT_LOG']), 'bisect')
})

test('base branch candidates: setting first, then origin/HEAD, then the usual names', () => {
  const main = ['refs/remotes/origin/main', 'refs/remotes/origin/master']
  assert.deepEqual(baseCandidates('', null), main)
  assert.deepEqual(baseCandidates('origin/dev', 'refs/remotes/origin/trunk'), ['refs/remotes/origin/dev', 'refs/remotes/origin/trunk', ...main])
  assert.deepEqual(baseCandidates('refs/remotes/up/dev', null), ['refs/remotes/up/dev', ...main])
  // full names only: "HEAD" or a tag can never become the base
  assert.deepEqual(baseCandidates('HEAD', null), ['refs/remotes/HEAD', ...main])
  // a local branch is never a base: it moves with your own unpushed commits
  assert.deepEqual(baseCandidates('refs/heads/main', null), main)
  assert.deepEqual(baseCandidates('refs/tags/v1', null), main)
  // unsafe values are dropped, never passed to git
  assert.deepEqual(baseCandidates('--upload-pack=x', 'refs/heads/../x'), main)
})

test('refs and paths are checked before they reach git', () => {
  for (const bad of ['-x', '--help', 'a..b', 'a b', '$(x)', '', 'a;b', 'a\nb']) assert.equal(isSafeRef(bad), false, bad)
  for (const good of ['origin/main', 'main', 'release-1.2/x']) assert.equal(isSafeRef(good), true, good)
  for (const bad of ['', 'relative/path', '-C', '/a\0b', 5, null]) assert.equal(isSafePath(bad), false, String(bad))
  assert.equal(isSafePath('/Users/me/a b/$(x)'), true)
})

test('gitArgs: fixed flags first, overrides, then -C and the command', () => {
  const a = gitArgs('/p', ['-c', 'filter.x.clean='], ['status'])
  assert.deepEqual(a.slice(0, GIT_FLAGS.length), [...GIT_FLAGS])
  assert.ok(a.includes('core.fsmonitor=false'))
  assert.ok(a.includes('--no-optional-locks'))
  assert.deepEqual(a.slice(-3), ['-C', '/p', 'status'])
})

test('filter overrides empty clean, smudge, process and required', () => {
  const f = filterOverrides('filter.lfs.clean\0filter.lfs.smudge\0filter.bar.clean\0user.name\0')
  assert.equal(f.unsafe, false)
  assert.deepEqual(f.args, [
    '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false',
    '-c', 'filter.bar.clean=', '-c', 'filter.bar.smudge=', '-c', 'filter.bar.process=', '-c', 'filter.bar.required=false'
  ])
  assert.deepEqual(filterOverrides('').args, [])
})

test('a filter name that cannot be passed safely marks the repository unsafe', () => {
  assert.equal(filterOverrides('filter.a=b.clean\0').unsafe, true)
  assert.equal(filterOverrides('filter.a b.clean\0').unsafe, true)
})

const clean: VerdictInput = {
  uncommitted: 0, staged: 0, untracked: 0, conflicts: 0, ahead: 0, upstream: 'origin/main',
  detached: false, stash: 0, merged: null, operation: null, agent: null
}
const matrix: [string, Partial<VerdictInput>, string, string][] = [
  ['clean with upstream', {}, 'safe', 'clean'],
  ['uncommitted', { uncommitted: 3 }, 'keep', '3 uncommitted'],
  ['staged only is uncommitted too', { uncommitted: 1, staged: 1 }, 'keep', '1 uncommitted'],
  ['conflict', { uncommitted: 1, conflicts: 1 }, 'keep', '1 conflict'],
  ['unpushed', { ahead: 2 }, 'keep', '2 unpushed'],
  ['unpushed but merged into base', { ahead: 2, merged: true }, 'safe', 'clean'],
  ['agent working', { agent: 'working' }, 'keep', 'agent working'],
  ['agent waits for permission', { agent: 'permission' }, 'keep', 'agent waits for you'],
  ['agent done is no reason', { agent: 'done' }, 'safe', 'clean'],
  ['rebase running', { operation: 'rebase' }, 'keep', 'rebase in progress'],
  ['merge running', { operation: 'merge' }, 'keep', 'merge in progress'],
  ['only untracked', { untracked: 4 }, 'check', '4 untracked'],
  ['stash', { stash: 1 }, 'check', '1 stash entry'],
  ['stashes', { stash: 2 }, 'check', '2 stash entries'],
  ['no upstream, has own commits', { upstream: null, merged: false }, 'check', 'no upstream'],
  ['no upstream, base unknown', { upstream: null, merged: null }, 'check', 'base branch unknown'],
  ['no upstream but merged', { upstream: null, merged: true }, 'safe', 'clean'],
  ['detached HEAD with commits outside the base branch', { detached: true, upstream: null, merged: false }, 'keep', 'detached HEAD with commits'],
  ['detached HEAD, base branch unknown', { detached: true, upstream: null, merged: null }, 'check', 'detached'],
  ['detached HEAD that is merged', { detached: true, upstream: null, merged: true }, 'safe', 'clean'],
  ['agent status unknown', { agentUnknown: true }, 'check', 'agent status unknown'],
  ['uncommitted beats untracked', { uncommitted: 1, untracked: 5 }, 'keep', '1 uncommitted']
]
for (const [name, patch, want, text] of matrix) {
  test(`verdict: ${name}`, () => {
    const v = verdict({ ...clean, ...patch })
    assert.equal(v.verdict, want)
    assert.ok(v.reasons.join(' | ').includes(text), `${v.reasons.join(' | ')} should include ${text}`)
  })
}

test('verdict: reasons name every cause', () => {
  const v = verdict({ ...clean, uncommitted: 3, ahead: 2, untracked: 1 })
  assert.deepEqual(v.reasons, ['3 uncommitted', '2 unpushed', '1 untracked'])
})

test('sorting: most uncommitted files first, then keep, check, safe, unknown, then name', () => {
  const list = [
    { name: 'b', uncommitted: 0, verdict: 'safe' as const },
    { name: 'a', uncommitted: 0, verdict: 'unknown' as const },
    { name: 'z', uncommitted: 2, verdict: 'keep' as const },
    { name: 'c', uncommitted: 0, verdict: 'keep' as const },
    { name: 'd', uncommitted: 0, verdict: 'check' as const },
    { name: 'y', uncommitted: 1, verdict: 'keep' as const }
  ].sort(compareSessions)
  assert.deepEqual(list.map((x) => x.name), ['z', 'y', 'c', 'd', 'b', 'a'])
})

test('commit time: seconds to milliseconds, junk is null', () => {
  assert.equal(parseCommitTime('1700000000\n'), 1700000000000)
  for (const bad of ['', 'abc', '-5', '12.5', '1700000000 extra', '9'.repeat(20)]) assert.equal(parseCommitTime(bad), null, bad)
})

test('shortstat: lines added and removed', () => {
  assert.deepEqual(parseShortstat(' 3 files changed, 120 insertions(+), 30 deletions(-)\n'), { added: 120, removed: 30 })
  assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+)\n'), { added: 1, removed: 0 })
  assert.deepEqual(parseShortstat(' 2 files changed, 7 deletions(-)\n'), { added: 0, removed: 7 })
  assert.deepEqual(parseShortstat(''), { added: 0, removed: 0 })
  assert.equal(parseShortstat('fatal: bad revision'), null)
})

test('commit subjects: at most 3, plain and short', () => {
  assert.deepEqual(parseSubjects('fix cart\0add hero\0'), ['fix cart', 'add hero'])
  assert.deepEqual(parseSubjects('a\0b\0c\0d\0e\0'), ['a', 'b', 'c'])
  assert.equal(parseSubjects('x'.repeat(500) + '\0')[0].length, 100)
  assert.deepEqual(parseSubjects('line\u001b[31mred\0'), ['line?[31mred'])
  assert.deepEqual(parseSubjects(''), [])
})

test('only plain upstream names go into a revision range', () => {
  assert.equal(isSafeUpstream('origin/feature/x'), true)
  for (const bad of ['-x', 'a..b', 'a b', '', null, 'a;b', 'a\nb']) assert.equal(isSafeUpstream(bad), false, String(bad))
})

test('status: tracked changes that still exist are listed for their time stamps', () => {
  const h = 'a'.repeat(40)
  const e = (xy: string, p: string) => `1 ${xy} N... 100644 100644 100644 ${h} ${h} ${p}`
  const s = parseStatus(z(...head('main'), e('.M', 'a.txt'), e('.D', 'gone.txt'), e('M.', '../escape.txt'), e('M.', '/abs.txt'), '? new.txt'))
  assert.deepEqual(s.statPaths, ['a.txt'])
})

test('every call carries the protection against log signatures and fetching', () => {
  const flags = GIT_FLAGS.join(' ')
  for (const part of ['log.showSignature=false', 'protocol.allow=never', 'protocol.file.allow=never', 'protocol.ssh.allow=never', 'protocol.ext.allow=never', 'core.fsmonitor=false']) {
    assert.ok(flags.includes(part), part)
  }
})

test('a partial clone is recognised from the config names', () => {
  assert.equal(filterOverrides('extensions.partialclone\0').partial, true)
  assert.equal(filterOverrides('remote.origin.promisor\0').partial, true)
  assert.equal(filterOverrides('remote.up.partialclonefilter\0').partial, true)
  assert.equal(filterOverrides('filter.x.clean\0').partial, false)
  assert.equal(filterOverrides('').partial, false)
})

test('status: a configured upstream without ahead/behind means the upstream is gone', () => {
  assert.equal(parseStatus(z(...head('main', ['# branch.upstream origin/main']))).upstreamGone, true)
  assert.equal(parseStatus(z(...head('main', ['# branch.upstream origin/main', '# branch.ab +0 -0']))).upstreamGone, false)
  assert.equal(parseStatus(z(...head('main'))).upstreamGone, false)
})

test('verdict: a gone upstream and submodules are never green', () => {
  const gone = verdict({ ...clean, upstream: null, upstreamGone: true, merged: false })
  assert.equal(gone.verdict, 'check')
  assert.ok(gone.reasons.join(' ').includes('upstream branch is gone'))
  assert.equal(verdict({ ...clean, submodules: true }).verdict, 'check')
  assert.equal(verdict({ ...clean, upstream: null, upstreamGone: true, merged: true }).verdict, 'safe')
})

test('names lose bidi controls too', () => {
  assert.equal(cleanPath('a\u202eb\u2066c\u200ed'), 'a?b?c?d')
})

test('verdict rank: keep is the worst, safe the best', () => {
  assert.deepEqual((['safe', 'check', 'unknown', 'keep'] as const).map(verdictRank), [0, 1, 1, 2])
})
