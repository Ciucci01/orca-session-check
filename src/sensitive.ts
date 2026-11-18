// Which files must not be committed, judged by the FILE NAME alone. Pure, no I/O: contents are never read.
// Every rule is listed in the README table; keep the two in step.

export type SensitiveKind = 'secret' | 'junk'
export type SensitiveMatch = { kind: SensitiveKind; rule: string }

/** Templates are meant to be committed: `.env.example`, `.npmrc.sample`, `terraform.tfvars.example` */
const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist', '.defaults', '.tmpl']

/** Exact names (lower case) and the rule they are shown as */
const SECRET_NAMES: Record<string, string> = {
  '.env': '.env',
  id_rsa: 'id_rsa',
  id_dsa: 'id_dsa',
  id_ecdsa: 'id_ecdsa',
  id_ed25519: 'id_ed25519',
  'credentials.json': 'credentials.json',
  '.npmrc': '.npmrc',
  '.pypirc': '.pypirc',
  '.netrc': '.netrc',
  '.htpasswd': '.htpasswd',
  '.git-credentials': '.git-credentials',
  '.pgpass': '.pgpass',
  'auth.json': 'auth.json',
  'secrets.yml': 'secrets.yml',
  'secrets.yaml': 'secrets.yaml',
  'secrets.json': 'secrets.json',
  'wp-config.php': 'wp-config.php'
}

/** Endings of private keys, key stores, password databases and Terraform state or variables */
const SECRET_ENDINGS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx', '.tfstate', '.tfstate.backup', '.tfvars', '.tfvars.json', '.ppk']

/** Start and end of a name, e.g. client_secret_123.apps.googleusercontent.com.json */
const SECRET_PATTERNS: readonly [string, string, string][] = [
  ['client_secret', '.json', 'client_secret*.json'],
  ['service-account', '.json', 'service-account*.json'],
  ['serviceaccount', '.json', 'serviceaccount*.json'],
  ['firebase-adminsdk', '.json', 'firebase-adminsdk*.json']
]

const JUNK_NAMES: Record<string, string> = { '.ds_store': '.DS_Store', 'thumbs.db': 'Thumbs.db' }

/** Archives and database dumps: only a warning while they are new (a tracked one is a decision someone made) */
const UNTRACKED_JUNK_ENDINGS = ['.zip', '.tar.gz', '.sql', '.dump']

function secretRule(base: string, segments: readonly string[]): string | null {
  if (TEMPLATE_SUFFIXES.some((s) => base.endsWith(s))) return null
  const exact = SECRET_NAMES[base]
  if (exact) return exact
  if (base.startsWith('.env.')) return '.env.*'
  if (base === 'credentials' && segments.length >= 2 && segments[segments.length - 2] === '.aws') return '.aws/credentials'
  if (base === 'config.json' && segments.length >= 2 && segments[segments.length - 2] === '.docker') return '.docker/config.json'
  // id_rsa.bak, id_ed25519.old: copies of a private key (the .pub files are fine)
  for (const key of ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']) if (base.startsWith(`${key}.`) && !base.endsWith('.pub')) return `${key}.*`
  for (const ending of SECRET_ENDINGS) if (base.endsWith(ending)) return `*${ending}`
  for (const [start, end, rule] of SECRET_PATTERNS) if (base.startsWith(start) && base.endsWith(end)) return rule
  return null
}

/**
 * The rule a path breaks, or null. Case does not matter. `untracked` allows the rules that only count for new
 * files (archives, dumps). A trailing slash is a folder git lists as a whole (`node_modules/`): only the folder
 * rules apply to it, a folder named `.env` (often a Python virtualenv) is not a secret.
 */
export function classify(path: string, opts: { untracked?: boolean } = {}): SensitiveMatch | null {
  if (typeof path !== 'string') return null
  const trimmed = path.replace(/\/+$/, '')
  if (!trimmed) return null
  const folder = trimmed.length !== path.length
  const segments = trimmed.toLowerCase().split('/')
  if (segments.includes('node_modules')) return { kind: 'junk', rule: 'node_modules/' }
  if (folder) return null
  // a name may end in spaces (legal in git): `.env ` is still read as .env by tools that trim it (other whitespace is not trimmed)
  const base = segments[segments.length - 1].replace(/ +$/, '')
  const junk = JUNK_NAMES[base]
  if (junk) return { kind: 'junk', rule: junk }
  const secret = secretRule(base, segments)
  if (secret) return { kind: 'secret', rule: secret }
  if (opts.untracked) for (const ending of UNTRACKED_JUNK_ENDINGS) if (base.endsWith(ending)) return { kind: 'junk', rule: `*${ending}` }
  return null
}
