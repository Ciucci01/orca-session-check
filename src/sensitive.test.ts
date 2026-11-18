import { assert, test } from 'orca/testing'
import { MAX_SENSITIVE, parseIndex, parseStatus, summarizeSensitive } from './git'
import type { SensitiveFile } from './protocol'
import { classify } from './sensitive'

const kind = (path: string, untracked = false) => classify(path, { untracked })?.kind ?? null
const rule = (path: string) => classify(path)?.rule ?? null

test('secret names are found, with the rule they break', () => {
  const cases: [string, string][] = [
    ['.env', '.env'],
    ['.env.local', '.env.*'],
    ['.env.production', '.env.*'],
    ['.env.development', '.env.*'],
    ['.env.staging', '.env.*'],
    ['.env.test', '.env.*'],
    ['server.pem', '*.pem'],
    ['tls.key', '*.key'],
    ['cert.p12', '*.p12'],
    ['cert.pfx', '*.pfx'],
    ['release.jks', '*.jks'],
    ['android.keystore', '*.keystore'],
    ['id_rsa', 'id_rsa'],
    ['id_dsa', 'id_dsa'],
    ['id_ecdsa', 'id_ecdsa'],
    ['id_ed25519', 'id_ed25519'],
    ['Passwörter.kdbx', '*.kdbx'],
    ['credentials.json', 'credentials.json'],
    ['client_secret.json', 'client_secret*.json'],
    ['client_secret_123-abc.apps.googleusercontent.com.json', 'client_secret*.json'],
    ['service-account.json', 'service-account*.json'],
    ['service-account-prod.json', 'service-account*.json'],
    ['serviceaccount.json', 'serviceaccount*.json'],
    ['serviceAccountKey.json', 'serviceaccount*.json'],
    ['.npmrc', '.npmrc'],
    ['.pypirc', '.pypirc'],
    ['.netrc', '.netrc'],
    ['.htpasswd', '.htpasswd'],
    ['secrets.yml', 'secrets.yml'],
    ['secrets.yaml', 'secrets.yaml'],
    ['secrets.json', 'secrets.json'],
    ['terraform.tfstate', '*.tfstate'],
    ['terraform.tfstate.backup', '*.tfstate.backup'],
    ['prod.tfvars', '*.tfvars'],
    ['.aws/credentials', '.aws/credentials'],
    ['wp-config.php', 'wp-config.php']
  ]
  for (const [path, want] of cases) {
    assert.equal(kind(path), 'secret', path)
    assert.equal(rule(path), want, path)
  }
})

test('templates are not secrets: every template ending', () => {
  for (const name of [
    '.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults', '.env.tmpl',
    '.npmrc.example', 'wp-config.php.sample', 'terraform.tfvars.example', 'secrets.yml.dist', 'credentials.json.template',
    '.env.local.example', 'server.pem.tmpl', '.ENV.EXAMPLE'
  ]) {
    assert.equal(classify(name), null, name)
    assert.equal(classify(name, { untracked: true }), null, name)
  }
})

test('public keys and look-alikes are not secrets', () => {
  for (const name of [
    'id_rsa.pub', 'id_ed25519.pub', 'id_rsa_backup.txt', 'env', 'env.ts', 'dotenv.js', '.envrc', 'environment.ts', 'keys.md',
    'key', 'monkey.ts', 'pem', 'credentials', 'credentials.ts', 'secrets.md', 'wp-config-sample.php', 'client.json',
    'account.json', 'README.md', 'tfvars', 'my.env', 'aws/credentials', '.aws/config'
  ]) {
    assert.equal(classify(name), null, name)
  }
})

test('case does not matter', () => {
  for (const name of ['.ENV', '.Env.Local', 'ID_RSA', 'Server.PEM', 'CREDENTIALS.JSON', 'WP-Config.php', '.AWS/Credentials', 'Client_Secret.JSON']) {
    assert.equal(kind(name), 'secret', name)
  }
  assert.equal(kind('.ds_store'), 'junk')
  assert.equal(kind('THUMBS.DB'), 'junk')
  assert.equal(kind('Node_Modules/x.js'), 'junk')
})

test('nested paths: the base name counts, .aws/credentials anywhere', () => {
  assert.equal(rule('apps/api/.env'), '.env')
  assert.equal(rule('deploy/keys/prod.key'), '*.key')
  assert.equal(rule('home/.ssh/id_ed25519'), 'id_ed25519')
  assert.equal(rule('conf/.aws/credentials'), '.aws/credentials')
  // a folder named like a secret does not make its files secrets
  assert.equal(classify('.env/README.md'), null)
  assert.equal(classify('id_rsa/notes.txt'), null)
})

test('junk: node_modules anywhere, .DS_Store, Thumbs.db; archives and dumps only when new', () => {
  assert.deepEqual(classify('node_modules/'), { kind: 'junk', rule: 'node_modules/' })
  assert.deepEqual(classify('packages/web/node_modules/react/index.js'), { kind: 'junk', rule: 'node_modules/' })
  // node_modules wins over a secret name inside it (package files, not yours)
  assert.equal(kind('node_modules/pkg/.env'), 'junk')
  assert.deepEqual(classify('src/.DS_Store'), { kind: 'junk', rule: '.DS_Store' })
  assert.deepEqual(classify('img/Thumbs.db'), { kind: 'junk', rule: 'Thumbs.db' })
  for (const [name, r] of [['backup.zip', '*.zip'], ['site.tar.gz', '*.tar.gz'], ['db.sql', '*.sql'], ['prod.dump', '*.dump']]) {
    assert.deepEqual(classify(name, { untracked: true }), { kind: 'junk', rule: r }, name)
    assert.equal(classify(name), null, `${name} tracked`)
  }
  for (const name of ['node_modules.md', 'my_node_modules/x', 'app.log', 'dist/', 'build/out.js', 'sql', 'x.sqlite']) assert.equal(classify(name, { untracked: true }), null, name)
})

test('a trailing slash is a folder: only folder rules apply', () => {
  assert.equal(kind('node_modules/', true), 'junk')
  assert.equal(kind('web/node_modules/', true), 'junk')
  // a Python virtualenv named .env is a folder, not a secret
  assert.equal(classify('.env/', { untracked: true }), null)
  assert.equal(classify('keys.pem/', { untracked: true }), null)
  assert.equal(classify('backup.zip/', { untracked: true }), null)
  assert.equal(classify('/'), null)
  assert.equal(classify(''), null)
  assert.equal(classify(5 as unknown as string), null)
})

test('names with spaces, unicode and control characters', () => {
  assert.equal(rule('my keys/prod server.pem'), '*.pem')
  assert.equal(rule('ünïcødé/.env.lokal'), '.env.*')
  assert.equal(rule('日本/.env'), '.env')
  // a control character makes it another name: it is not .env, and nothing throws
  assert.equal(classify('.env\n'), null)
  assert.equal(rule('dir\nname/.env'), '.env')
  assert.equal(rule('a‮/.npmrc'), '.npmrc')
})

test('very long names are judged and do not take long', () => {
  const long = `${'d/'.repeat(5000)}${'x'.repeat(100_000)}.pem`
  const started = Date.now()
  assert.equal(rule(long), '*.pem')
  assert.equal(classify('y'.repeat(200_000)), null)
  assert.ok(Date.now() - started < 500)
})

// The status and index parsers judge every entry, the summary cuts the list

const h = 'a'.repeat(40)
const changed = (xy: string, p: string) => `1 ${xy} N... 100644 100644 100644 ${h} ${h} ${p}`
const z = (...lines: string[]) => `${lines.join('\0')}\0`

test('status: secrets beyond the 20 listed files are still found', () => {
  const lines = Array.from({ length: 40 }, (_, i) => changed('.M', `src/f${i}.ts`))
  lines.push(changed('.M', 'config/.env.production'), '? .env', '? node_modules/', '? dump.sql', changed('.M', 'old.sql'))
  const s = parseStatus(z('# branch.oid ' + h, '# branch.head main', ...lines))
  assert.equal(s.files.length, 20)
  assert.ok(!s.files.some((f) => f.path.includes('.env')))
  assert.deepEqual(
    s.findings.map((f) => [f.path, f.kind, f.tracked, f.rule]),
    [
      ['config/.env.production', 'secret', true, '.env.*'],
      ['.env', 'secret', false, '.env'],
      ['node_modules/', 'junk', false, 'node_modules/'],
      ['dump.sql', 'junk', false, '*.sql']
    ]
  )
})

test('status: a deleted secret is not reported (deleting it is the fix), a renamed one by its new name', () => {
  const s = parseStatus(z(changed('.D', '.env'), changed('D.', 'id_rsa'), `2 R. N... 100644 100644 100644 ${h} ${h} R100 prod.key\0old.txt`))
  assert.deepEqual(s.findings.map((f) => f.path), ['prod.key'])
})

test('index: gitlinks and tracked secrets from one list, a conflict counted once, junk left out', () => {
  const e = (mode: string, stage: number, p: string) => `${mode} ${h} ${stage}\t${p}`
  const out = z(e('100644', 0, 'a.txt'), e('160000', 0, 'vendor'), e('100644', 1, '.env'), e('100644', 2, '.env'), e('100644', 3, '.env'), e('100600', 0, 'keys/id_rsa'), e('100644', 0, '.env.example'), e('100644', 0, 'node_modules/x.js'))
  const idx = parseIndex(out)
  assert.equal(idx.gitlinks, true)
  assert.deepEqual(idx.secrets.map((f) => [f.path, f.tracked, f.rule]), [['.env', true, '.env'], ['keys/id_rsa', true, 'id_rsa']])
  assert.deepEqual(parseIndex(z(e('100644', 0, 'a.txt'))), { gitlinks: false, gitmodules: false, secrets: [] })
  assert.deepEqual(parseIndex(''), { gitlinks: false, gitmodules: false, secrets: [] })
  // an entry without a tab is skipped
  assert.deepEqual(parseIndex('garbage\0'), { gitlinks: false, gitmodules: false, secrets: [] })
  // a tracked .gitmodules is a submodule sign of its own
  assert.equal(parseIndex(z(e('100644', 0, '.gitmodules'))).gitmodules, true)
})

test('summary: one entry per path, tracked secrets first, counts are not cut, paths are cleaned', () => {
  const f = (path: string, k: 'secret' | 'junk', tracked: boolean): SensitiveFile => ({ path, kind: k, tracked, rule: 'r' })
  const many = Array.from({ length: 15 }, (_, i) => f(`n${String(i).padStart(2, '0')}.pem`, 'secret', false))
  const s = summarizeSensitive([f('node_modules/', 'junk', false), ...many, f('.env', 'secret', true), f('.env', 'secret', true), f('a‮b.key', 'secret', true)])
  assert.equal(s.sensitive.length, MAX_SENSITIVE)
  assert.equal(s.sensitiveCount, 18)
  assert.equal(s.sensitiveSecrets, 17)
  assert.equal(s.sensitiveTracked, 2)
  assert.deepEqual(s.sensitive.slice(0, 3).map((x) => [x.path, x.tracked]), [['.env', true], ['a?b.key', true], ['n00.pem', false]])
  assert.ok(!s.sensitive.some((x) => x.kind === 'junk'))
  const long = summarizeSensitive([f(`${'x'.repeat(1000)}.pem`, 'secret', false)])
  assert.ok(long.sensitive[0].path.length <= 301)
  assert.deepEqual(summarizeSensitive([]), { sensitive: [], sensitiveCount: 0, sensitiveSecrets: 0, sensitiveTracked: 0 })
})

test('more secret names: git credentials, pgpass, putty keys, firebase, docker config, key copies, trailing spaces', () => {
  for (const name of ['.git-credentials', '.pgpass', 'deploy.ppk', 'firebase-adminsdk-abc.json', 'terraform.tfvars.json', 'home/.docker/config.json', 'auth.json', 'id_rsa.bak', 'id_ed25519.old', '.env ']) {
    assert.equal(classify(name)?.kind, 'secret', name)
  }
  for (const name of ['id_rsa.pub', 'id_ed25519.pub', 'config.json', 'docker/config.json', 'app/auth.js', '.env.example', '.env\t']) {
    assert.equal(classify(name)?.kind === 'secret', false, name)
  }
})
