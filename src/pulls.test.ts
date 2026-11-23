import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { CLI, cliEnv, forgeOf, lookupPullRequest, parseConfig, parseRemote, pickGithub, pickGitlab, targetOf } from './pulls'

test('remote URLs in every form give host and path; anything odd gives nothing', () => {
  const acme = { host: 'github.com', path: 'acme/shop' }
  for (const url of [
    'git@github.com:acme/shop.git',
    'git@github.com:acme/shop',
    'https://github.com/acme/shop.git',
    'https://github.com/acme/shop/',
    'https://token@github.com/acme/shop',
    'ssh://git@github.com/acme/shop.git',
    'ssh://git@github.com:22/acme/shop',
    'https://GitHub.com/acme/shop'
  ]) assert.deepEqual(parseRemote(url), acme, url)
  assert.deepEqual(parseRemote('git@gitlab.acme.test:team/web/shop.git'), { host: 'gitlab.acme.test', path: 'team/web/shop' })
  assert.deepEqual(parseRemote('https://gitlab.acme.test:8443/team/shop'), { host: 'gitlab.acme.test', path: 'team/shop' })
  for (const url of ['https://github.com/acme', 'https://github.com/ac me/shop', 'https://github.com/acme/..', 'git@-x.test:a/b', 'git@localhost:a/b', '/srv/git/shop.git', '']) {
    assert.equal(parseRemote(url), null, url)
  }
})

test('github.com goes to gh, a gitlab host to glab, anything else to neither', () => {
  assert.equal(forgeOf({ host: 'github.com', path: 'acme/shop' }), 'github')
  assert.equal(forgeOf({ host: 'github.com', path: 'acme/shop/tree' }), null)
  assert.equal(forgeOf({ host: 'gitlab.com', path: 'acme/shop' }), 'gitlab')
  assert.equal(forgeOf({ host: 'gitlab.acme.test', path: 'team/web/shop' }), 'gitlab')
  for (const host of ['github.com.evil.test', 'evil.test', 'mygitlab.test', 'bitbucket.org']) assert.equal(forgeOf({ host, path: 'a/b' }), null, host)
})

test('git config output: key and value per entry, the last value wins', () => {
  const cfg = parseConfig('remote.origin.url\ngit@github.com:a/b.git\0branch.feat.remote\norigin\0remote.origin.url\ngit@github.com:c/d.git\0')
  assert.equal(cfg.get('remote.origin.url'), 'git@github.com:c/d.git')
  assert.equal(cfg.get('branch.feat.remote'), 'origin')
  assert.equal(parseConfig('').size, 0)
})

const config = (entries: Record<string, string>) => new Map(Object.entries(entries))
const github = (repo: string, head: string, headRepo = repo) => ({ forge: 'github', host: 'github.com', repo, head, headRepo })

test('the pull request is looked for where gh looks: set-default, then upstream, github, origin', () => {
  // Own repository: base and head are origin
  assert.deepEqual(targetOf(config({ 'remote.origin.url': 'git@github.com:acme/shop.git', 'branch.feat.remote': 'origin', 'branch.feat.merge': 'refs/heads/feat' }), 'feat'), github('acme/shop', 'feat'))
  // A fork: the pull request is on upstream, opened from the fork
  const fork = { 'remote.origin.url': 'git@github.com:me/shop.git', 'remote.upstream.url': 'git@github.com:acme/shop.git', 'branch.fix/x.remote': 'origin', 'branch.fix/x.merge': 'refs/heads/fix/x' }
  assert.deepEqual(targetOf(config(fork), 'fix/x'), github('acme/shop', 'fix/x', 'me/shop'))
  // `gh repo set-default` wins over the names
  assert.deepEqual(targetOf(config({ ...fork, 'remote.parent.url': 'https://github.com/big/shop', 'remote.parent.gh-resolved': 'base' }), 'fix/x')?.repo, 'big/shop')
  // Never pushed with an upstream: origin and the local name
  assert.deepEqual(targetOf(config({ 'remote.origin.url': 'git@github.com:acme/shop.git' }), 'feat'), github('acme/shop', 'feat'))
  // Made from origin/main (`git worktree add -b feat <path> origin/main`), so it tracks main: never ask about main
  assert.deepEqual(targetOf(config({ 'remote.origin.url': 'git@github.com:acme/shop.git', 'branch.feat.remote': 'origin', 'branch.feat.merge': 'refs/heads/main' }), 'feat'), github('acme/shop', 'feat'))
  // A fork branch made from upstream/main is still pushed to the fork
  assert.deepEqual(targetOf(config({ ...fork, 'branch.fix/x.remote': 'upstream', 'branch.fix/x.merge': 'refs/heads/main' }), 'fix/x'), github('acme/shop', 'fix/x', 'me/shop'))
})

test('a GitLab project, nested groups included, goes to glab with its host', () => {
  assert.deepEqual(targetOf(config({ 'remote.origin.url': 'git@gitlab.acme.test:team/web/shop.git' }), 'feature/x'), {
    forge: 'gitlab', host: 'gitlab.acme.test', repo: 'team/web/shop', head: 'feature/x', headRepo: 'team/web/shop'
  })
})

test('no target off GitHub and GitLab, across hosts, without remote, or with a branch name the CLIs must not get', () => {
  assert.equal(targetOf(config({ 'remote.origin.url': 'git@bitbucket.org:acme/shop.git' }), 'feat'), null)
  assert.equal(targetOf(config({ 'remote.origin.url': 'git@github.com:me/shop.git', 'remote.upstream.url': 'git@gitlab.acme.test:acme/shop.git' }), 'feat'), null)
  assert.equal(targetOf(config({}), 'feat'), null)
  // Tracks a local branch: no remote URL
  assert.equal(targetOf(config({ 'remote.origin.url': 'git@github.com:acme/shop.git', 'branch.feat.remote': '.', 'branch.feat.merge': 'refs/heads/feat' }), 'feat'), null)
  assert.equal(targetOf(config({ 'remote.origin.url': 'git@github.com:acme/shop.git' }), 'a b'), null)
})

// The branch's HEAD, and another commit
const OID = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
// Fields of `glab mr list --output json` (trimmed): a merge request in the same project
const gitlabMr = (iid: number, state: string, draft = false, source = 530, target = 530, sha = OID) => ({ iid, state, draft, sha, source_project_id: source, target_project_id: target })
// What `gh pr list --json number,state,isDraft,headRepositoryOwner,headRefOid` printed for a merged pull request from a fork
const MERGED_FROM_FORK = `[{"headRefOid":"${OID}","headRepositoryOwner":{"id":"MDQ6VXNlcjU4ODUzNDA3","name":"Someone","login":"Me"},"isDraft":false,"number":2,"state":"MERGED"}]`

test('gh: the pull request from the head owner, an open one first, else the newest; garbage is none', () => {
  assert.deepEqual(pickGithub(MERGED_FROM_FORK, 'me', OID), { forge: 'github', number: 2, state: 'merged' })
  // Someone else's pull request from a branch with the same name does not count
  assert.equal(pickGithub(MERGED_FROM_FORK, 'acme', OID), null)
  const row = (number: number, state: string, isDraft = false, headRefOid = OID) => ({ number, state, isDraft, headRefOid, headRepositoryOwner: { login: 'me' } })
  assert.deepEqual(pickGithub(JSON.stringify([row(9, 'CLOSED'), row(5, 'OPEN')]), 'me', OID), { forge: 'github', number: 5, state: 'open' })
  assert.deepEqual(pickGithub(JSON.stringify([row(9, 'CLOSED'), row(5, 'MERGED')]), 'me', OID), { forge: 'github', number: 9, state: 'closed' })
  assert.deepEqual(pickGithub(JSON.stringify([row(4, 'OPEN', true)]), 'me', OID), { forge: 'github', number: 4, state: 'draft' })
  for (const json of ['[]', 'not json', '{"number":1}', JSON.stringify([row(1.5, 'OPEN'), { number: 2, state: 'OPEN', headRepositoryOwner: null }]), JSON.stringify([row(3, 'WEIRD')])]) {
    assert.equal(pickGithub(json, 'me', OID), null, json)
  }
})

test('a merged or closed request counts only while its last commit is the HEAD; an open one always', () => {
  const row = (number: number, state: string, headRefOid: string) => ({ number, state, isDraft: false, headRefOid, headRepositoryOwner: { login: 'me' } })
  // The branch moved on after the merge (develop after a release): no green "merged"
  assert.equal(pickGithub(JSON.stringify([row(9, 'MERGED', OTHER)]), 'me', OID), null)
  // An older one that is the HEAD still counts
  assert.deepEqual(pickGithub(JSON.stringify([row(9, 'MERGED', OTHER), row(8, 'CLOSED', OID)]), 'me', OID), { forge: 'github', number: 8, state: 'closed' })
  // Open with local commits not pushed yet: still the branch's request
  assert.deepEqual(pickGithub(JSON.stringify([row(7, 'OPEN', OTHER)]), 'me', OID), { forge: 'github', number: 7, state: 'open' })
  assert.equal(pickGithub(JSON.stringify([row(9, 'MERGED', OID)]), 'me', null), null)
  assert.equal(pickGitlab(JSON.stringify([gitlabMr(1121, 'merged', false, 530, 530, OTHER)]), false, OID), null)
})

test('glab: merge requests from the same project, or from a fork when pushed to one; locked counts as closed', () => {
  assert.deepEqual(pickGitlab(JSON.stringify([gitlabMr(1121, 'merged')]), false, OID), { forge: 'gitlab', number: 1121, state: 'merged' })
  assert.deepEqual(pickGitlab(JSON.stringify([gitlabMr(9, 'closed'), gitlabMr(7, 'opened', true)]), false, OID), { forge: 'gitlab', number: 7, state: 'draft' })
  assert.deepEqual(pickGitlab(JSON.stringify([gitlabMr(3, 'locked')]), false, OID), { forge: 'gitlab', number: 3, state: 'closed' })
  // A fork's merge request is not this branch's when the branch lives in the project, and the other way round
  const fromFork = JSON.stringify([gitlabMr(5, 'opened', false, 900, 530)])
  assert.equal(pickGitlab(fromFork, false, OID), null)
  assert.deepEqual(pickGitlab(fromFork, true, OID), { forge: 'gitlab', number: 5, state: 'open' })
  for (const json of ['[]', 'not json', JSON.stringify([{ iid: 1, state: 'opened' }])]) assert.equal(pickGitlab(json, false, OID), null, json)
})

test('gh and glab get only what they need to log in and reach the network; never GITLAB_TOKEN, which glab would send to any host', () => {
  const env = cliEnv({ PATH: '/bin', HOME: '/home/me', GH_TOKEN: 't', GITLAB_TOKEN: 'g', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus', GIT_DIR: '/evil', GH_PAGER: 'evil', GITLAB_HOST: 'evil.test' })
  assert.deepEqual(env, {
    GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1',
    GLAB_NO_PROMPT: '1', GLAB_CHECK_UPDATE: 'false', GLAB_SEND_TELEMETRY: 'false',
    PATH: '/bin', HOME: '/home/me', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus', GH_TOKEN: 't'
  })
})

// End to end with a real repository and fake gh and glab that record how they were called
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=a@acme.test', '-c', 'user.name=acme', ...args], { cwd, env: ENV, stdio: 'ignore' })

async function withFakes(scripts: { gh?: string; glab?: string }, fn: (repo: string, log: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'acme-cli-'))
  const before = { ...CLI }
  try {
    const log = join(dir, 'calls.log')
    for (const name of ['gh', 'glab'] as const) {
      const fake = join(dir, name)
      await writeFile(fake, `#!/bin/sh\necho "${name} $(pwd) $*" >> "${log}"\n${scripts[name] ?? 'exit 1'}\n`)
      await chmod(fake, 0o755)
      CLI[name] = fake
    }
    const repo = join(dir, 'repo')
    execFileSync('mkdir', [repo])
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(repo, 'checkout', '-q', '-b', 'fix/x')
    await fn(repo, log)
  } finally {
    Object.assign(CLI, before)
    await rm(dir, { recursive: true, force: true })
  }
}
const calls = async (log: string): Promise<string[]> => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)

test('a GitHub fork: gh is asked about upstream from outside the worktree, and the merged pull request comes back', async () => {
  await withFakes({ gh: `echo '${MERGED_FROM_FORK}'` }, async (repo, log) => {
    git(repo, 'remote', 'add', 'origin', 'git@github.com:me/shop.git')
    git(repo, 'remote', 'add', 'upstream', 'git@github.com:acme/shop.git')
    git(repo, 'config', 'branch.fix/x.remote', 'origin')
    git(repo, 'config', 'branch.fix/x.merge', 'refs/heads/fix/x')
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x', OID), { pr: { forge: 'github', number: 2, state: 'merged' } })
    assert.deepEqual(await calls(log), [`gh ${await realpath(tmpdir())} pr list --repo=github.com/acme/shop --head=fix/x --state=all --json=number,state,isDraft,headRepositoryOwner,headRefOid --limit=20`])
  })
})

test('a GitLab project where glab is logged in: the merge request comes back; elsewhere glab is not asked for it', async () => {
  // Like glab: `config get` exits 0 and prints nothing for a host without login
  const glab = `case "$1" in config) if [ "$3" = "--host=gitlab.acme.test" ]; then echo me; fi;; mr) echo '${JSON.stringify([gitlabMr(1121, 'merged')])}';; esac`
  await withFakes({ glab }, async (repo, log) => {
    git(repo, 'remote', 'add', 'origin', 'git@gitlab.acme.test:team/web/shop.git')
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x', OID), { pr: { forge: 'gitlab', number: 1121, state: 'merged' } })
    assert.deepEqual(await calls(log), [
      `glab ${await realpath(tmpdir())} config get --host=gitlab.acme.test user`,
      `glab ${await realpath(tmpdir())} mr list --repo=https://gitlab.acme.test/team/web/shop --source-branch=fix/x --all --output=json --per-page=20`
    ])
    // A host glab has no login for, as a repository may name any: only the local config is read
    git(repo, 'remote', 'set-url', 'origin', 'git@gitlab.evil.test:team/shop.git')
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x', OID), { pr: null })
    assert.equal((await calls(log)).filter((c) => c.includes(' mr ')).length, 1)
  })
})

test('no GitHub or GitLab remote: neither CLI starts', async () => {
  await withFakes({ gh: 'echo "[]"', glab: 'echo "[]"' }, async (repo, log) => {
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x', OID), { pr: null })
    git(repo, 'remote', 'add', 'origin', 'git@bitbucket.org:acme/shop.git')
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x', OID), { pr: null })
    assert.deepEqual(await calls(log), [])
  })
})

test('a CLI missing, not logged in or failing: a fixed error text, never its output', async () => {
  await withFakes({ gh: 'echo "secret details" >&2; exit 4' }, async (repo) => {
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git')
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x', OID), { error: 'gh is not logged in' })
    CLI.gh = '/nonexistent/gh'
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x', OID), { error: 'gh is not installed' })
  })
  await withFakes({ glab: 'echo "secret details"; exit 1' }, async (repo) => {
    git(repo, 'remote', 'add', 'origin', 'git@gitlab.acme.test:acme/shop.git')
    assert.deepEqual(await lookupPullRequest(repo, 'fix/x', OID), { error: 'glab failed' })
  })
})
