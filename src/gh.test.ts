import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { GH, ghEnv, lookupPullRequest, parseConfig, parseGithubUrl, pickPullRequest, targetOf } from './gh'

test('github.com remote URLs in every form; any other host or an odd name is not one', () => {
  const acme = { owner: 'acme', name: 'shop' }
  for (const url of [
    'git@github.com:acme/shop.git',
    'git@github.com:acme/shop',
    'https://github.com/acme/shop.git',
    'https://github.com/acme/shop/',
    'https://token@github.com/acme/shop',
    'ssh://git@github.com/acme/shop.git',
    'ssh://git@github.com:22/acme/shop',
    'https://GitHub.com/acme/shop'
  ]) assert.deepEqual(parseGithubUrl(url), acme, url)
  for (const url of [
    'git@gitlab.com:acme/shop.git',
    'https://github.com.evil.test/acme/shop',
    'https://evil.test/github.com/acme/shop',
    'https://github.com/acme',
    'https://github.com/acme/shop/tree/main',
    'https://github.com/ac me/shop',
    'https://github.com/acme/..',
    '/srv/git/shop.git',
    ''
  ]) assert.equal(parseGithubUrl(url), null, url)
})

test('git config output: key and value per entry, the last value wins', () => {
  const cfg = parseConfig('remote.origin.url\ngit@github.com:a/b.git\0branch.feat.remote\norigin\0remote.origin.url\ngit@github.com:c/d.git\0')
  assert.equal(cfg.get('remote.origin.url'), 'git@github.com:c/d.git')
  assert.equal(cfg.get('branch.feat.remote'), 'origin')
  assert.equal(parseConfig('').size, 0)
})

const config = (entries: Record<string, string>) => new Map(Object.entries(entries))

test('the pull request is looked for where gh looks: set-default, then upstream, github, origin', () => {
  // Own repository: base and head are origin
  assert.deepEqual(targetOf(config({ 'remote.origin.url': 'git@github.com:acme/shop.git', 'branch.feat.remote': 'origin', 'branch.feat.merge': 'refs/heads/feat' }), 'feat'), {
    repo: 'acme/shop', headOwner: 'acme', head: 'feat'
  })
  // A fork: the pull request is on upstream, opened from the fork's owner
  const fork = { 'remote.origin.url': 'git@github.com:me/shop.git', 'remote.upstream.url': 'git@github.com:acme/shop.git', 'branch.fix/x.remote': 'origin', 'branch.fix/x.merge': 'refs/heads/fix/x' }
  assert.deepEqual(targetOf(config(fork), 'fix/x'), { repo: 'acme/shop', headOwner: 'me', head: 'fix/x' })
  // `gh repo set-default` wins over the names
  assert.deepEqual(targetOf(config({ ...fork, 'remote.parent.url': 'https://github.com/big/shop', 'remote.parent.gh-resolved': 'base' }), 'fix/x')?.repo, 'big/shop')
  // Never pushed with an upstream: origin and the local name
  assert.deepEqual(targetOf(config({ 'remote.origin.url': 'git@github.com:acme/shop.git' }), 'feat'), { repo: 'acme/shop', headOwner: 'acme', head: 'feat' })
  // Made from origin/main (`git worktree add -b feat <path> origin/main`), so it tracks main: never ask about main
  assert.deepEqual(targetOf(config({ 'remote.origin.url': 'git@github.com:acme/shop.git', 'branch.feat.remote': 'origin', 'branch.feat.merge': 'refs/heads/main' }), 'feat'), {
    repo: 'acme/shop', headOwner: 'acme', head: 'feat'
  })
  // A fork branch made from upstream/main is still pushed to the fork
  assert.deepEqual(targetOf(config({ ...fork, 'branch.fix/x.remote': 'upstream', 'branch.fix/x.merge': 'refs/heads/main' }), 'fix/x'), { repo: 'acme/shop', headOwner: 'me', head: 'fix/x' })
})

test('no target off github.com, without remote, or with a branch name gh must not get', () => {
  assert.equal(targetOf(config({ 'remote.origin.url': 'git@gitlab.com:acme/shop.git' }), 'feat'), null)
  assert.equal(targetOf(config({ 'remote.origin.url': 'git@github.com:me/shop.git', 'remote.upstream.url': 'git@gitlab.com:acme/shop.git' }), 'feat'), null)
  assert.equal(targetOf(config({}), 'feat'), null)
  // Tracks a local branch: no remote URL
  assert.equal(targetOf(config({ 'remote.origin.url': 'git@github.com:acme/shop.git', 'branch.feat.remote': '.', 'branch.feat.merge': 'refs/heads/feat' }), 'feat'), null)
  assert.equal(targetOf(config({ 'remote.origin.url': 'git@github.com:acme/shop.git' }), 'a b'), null)
})

// What `gh pr list --json number,state,isDraft,headRepositoryOwner` printed for a merged pull request from a fork
const MERGED_FROM_FORK = '[{"headRepositoryOwner":{"id":"MDQ6VXNlcjU4ODUzNDA3","name":"Someone","login":"Me"},"isDraft":false,"number":2,"state":"MERGED"}]'

test('the pull request from the head owner: an open one first, else the newest; garbage is none', () => {
  assert.deepEqual(pickPullRequest(MERGED_FROM_FORK, 'me'), { number: 2, state: 'merged' })
  // Someone else's pull request from a branch with the same name does not count
  assert.equal(pickPullRequest(MERGED_FROM_FORK, 'acme'), null)
  const row = (number: number, state: string, isDraft = false, login = 'me') => ({ number, state, isDraft, headRepositoryOwner: { login } })
  assert.deepEqual(pickPullRequest(JSON.stringify([row(9, 'CLOSED'), row(5, 'OPEN')]), 'me'), { number: 5, state: 'open' })
  assert.deepEqual(pickPullRequest(JSON.stringify([row(9, 'CLOSED'), row(5, 'MERGED')]), 'me'), { number: 9, state: 'closed' })
  assert.deepEqual(pickPullRequest(JSON.stringify([row(4, 'OPEN', true)]), 'me'), { number: 4, state: 'draft' })
  assert.equal(pickPullRequest('[]', 'me'), null)
  assert.equal(pickPullRequest('not json', 'me'), null)
  assert.equal(pickPullRequest('{"number":1}', 'me'), null)
  assert.equal(pickPullRequest(JSON.stringify([row(1.5, 'OPEN'), { number: 2, state: 'OPEN', headRepositoryOwner: null }]), 'me'), null)
  assert.equal(pickPullRequest(JSON.stringify([row(3, 'WEIRD')]), 'me'), null)
})

test('gh gets only what it needs to log in and reach the network, no prompts, no update check', () => {
  const env = ghEnv({ PATH: '/bin', HOME: '/home/me', GH_TOKEN: 't', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus', GIT_DIR: '/evil', GH_PAGER: 'evil', GH_BROWSER: 'evil' })
  assert.deepEqual(env, {
    GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1',
    PATH: '/bin', HOME: '/home/me', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus', GH_TOKEN: 't'
  })
})

// End to end with a real repository and a fake gh that records how it was called
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=a@acme.test', '-c', 'user.name=acme', ...args], { cwd, env: ENV, stdio: 'ignore' })

async function withFakeGh(script: string, fn: (dir: string, log: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'acme-gh-'))
  const before = GH.command
  try {
    const log = join(dir, 'gh.log')
    const fake = join(dir, 'gh')
    await writeFile(fake, `#!/bin/sh\npwd > "${log}"\nfor a in "$@"; do echo "$a" >> "${log}"; done\n${script}\n`)
    await chmod(fake, 0o755)
    GH.command = fake
    const repo = join(dir, 'repo')
    execFileSync('mkdir', [repo])
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(repo, 'checkout', '-q', '-b', 'fix/x')
    await fn(repo, log)
  } finally {
    GH.command = before
    await rm(dir, { recursive: true, force: true })
  }
}

test('a fork: gh is asked about upstream from outside the worktree, and the merged pull request comes back', async () => {
  await withFakeGh(`echo '${MERGED_FROM_FORK}'`, async (repo, log) => {
    git(repo, 'remote', 'add', 'origin', 'git@github.com:me/shop.git')
    git(repo, 'remote', 'add', 'upstream', 'git@github.com:acme/shop.git')
    git(repo, 'config', 'branch.fix/x.remote', 'origin')
    git(repo, 'config', 'branch.fix/x.merge', 'refs/heads/fix/x')
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x'), { pr: { number: 2, state: 'merged' } })
    const [cwd, ...args] = (await readFile(log, 'utf8')).trim().split('\n')
    assert.ok(!cwd.startsWith(repo), `gh ran in ${cwd}`)
    assert.deepEqual(args, ['pr', 'list', '--repo=github.com/acme/shop', '--head=fix/x', '--state=all', '--json=number,state,isDraft,headRepositoryOwner', '--limit=20'])
  })
})

test('no github.com remote: gh is never started', async () => {
  await withFakeGh('echo "[]"', async (repo, log) => {
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x'), { pr: null })
    git(repo, 'remote', 'add', 'origin', 'git@gitlab.com:acme/shop.git')
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x'), { pr: null })
    assert.equal(await readFile(log, 'utf8').catch(() => null), null)
  })
})

test('gh missing, not logged in or failing: a fixed error text, never gh output', async () => {
  await withFakeGh('echo "secret details" >&2; exit 4', async (repo) => {
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git')
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x'), { error: 'gh is not logged in' })
    GH.command = '/nonexistent/gh'
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x'), { error: 'gh is not installed' })
  })
  await withFakeGh('exit 1', async (repo) => {
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git')
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x'), { error: 'gh failed' })
  })
})
