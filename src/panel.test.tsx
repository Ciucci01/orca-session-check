import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Config, Session, SessionsState } from './protocol'

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

const cfg: Config = { baseBranch: '', intervalSeconds: 30, notifyOnAgentDone: true, backgroundSeconds: 120, language: 'auto', warnSensitive: true }
const base: Session = {
  id: '', name: '', project: 'acme-shop', branch: 'main', current: false, hidden: false, verdict: 'safe', reasons: ['clean, nothing unpushed'],
  uncommitted: 0, staged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, upstream: 'origin/main', upstreamGone: false, submodules: false, stash: 0, stashTotal: 0,
  merged: null, operation: null, agent: null, files: [], moreFiles: 0, error: null, errorCode: null, lastCommitAt: null, lastActiveAt: null, unpushed: [], added: null, removed: null, dirtySince: null, sensitive: [], sensitiveCount: 0, sensitiveSecrets: 0, sensitiveTracked: 0, checkedAt: 1
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

t('the settings show the background refresh and the notification switch and save them', async () => {
  const sent: unknown[] = []
  const host = mockHost({
    requests: {
      'sessions.get': state([safe]),
      'sessions.refresh': state([safe]),
      'config.get': cfg,
      'config.set': (input) => {
        sent.push(input)
        return { ...cfg, ...input }
      }
    }
  })
  const view = await open(host)
  await view.toggle({ type: 'Collapsible', label: 'Settings' })
  const select = view.find({ type: 'Select', label: 'Status bar refresh in the background' })
  assert.ok(select)
  assert.equal(view.valueOf(select), '120')
  await view.select(select, '0')
  const sw = view.find({ type: 'Switch', label: 'Notify when an agent finishes and leaves open work' })
  assert.ok(sw)
  assert.equal(view.valueOf(sw), true)
  await view.toggle(sw)
  assert.deepEqual(sent, [{ backgroundSeconds: 0 }, { notifyOnAgentDone: false }])
  assert.equal(view.valueOf({ type: 'Switch', label: 'Notify when an agent finishes and leaves open work' }), false)
  await view.unmount()
})

// Languages: the setting wins, auto follows Orca's language (env.locale)

const many: Session[] = [
  { ...dirty, files: [{ state: '.M', path: 'src/cart.tsx' }, { state: '??', path: 'src/hero.tsx' }], moreFiles: 0, untracked: 1, conflicts: 1 },
  { ...safe, id: 'w3', name: 'gone', verdict: 'unknown', error: 'folder not found', errorCode: 'err.folderNotFound', upstream: null },
  { ...safe, id: 'w4', name: 'mine', current: true }
]
async function openIn(language: Config['language'], locale?: string, extra: Record<string, unknown> = {}) {
  const host = mockHost({ requests: { 'sessions.get': state(many), 'sessions.refresh': state(many), 'config.get': { ...cfg, language }, 'ui.locale': { ok: true }, ...extra } })
  const v = await mount(panel, { host, ...(locale ? { locale } : {}) })
  views.push(v)
  return v
}

async function assertGerman(v: Awaited<ReturnType<typeof openIn>>) {
  assert.ok(v.find({ text: '1 Worktree mit nicht committeten Dateien' }))
  assert.ok(v.find({ text: 'Aktuelle Session' }))
  assert.ok(v.find({ text: 'Nicht committete Dateien' }))
  assert.ok(v.find({ text: 'Alle 3' }) && v.find({ text: 'Nicht committet 1' }) && v.find({ text: 'Schließbar 1' }))
  assert.ok(v.find({ text: '3 geändert' }) && v.find({ text: '2 ungepusht' }) && v.find({ text: '1 Konflikt' }) && v.find({ text: '1 nicht versioniert' }))
  assert.ok(v.find({ text: 'sauber' }))
  assert.ok(v.findAll({ text: 'Öffnen' }).length >= 1 && v.findAll({ text: 'Ausblenden' }).length >= 1)
  assert.ok(v.find({ text: 'Gruppieren nach' }) && v.find({ text: 'Projekt' }))
  assert.ok(v.find({ label: 'Worktrees suchen' }))
}

t('the language setting de draws the panel in German, chips and settings included', async () => {
  const v = await openIn('de', 'en-US')
  await assertGerman(v)
  // the group that is folded away, with the translated error chip
  await v.toggle({ type: 'Collapsible', label: 'Nicht geprüft' })
  assert.ok(v.find({ text: 'Ordner nicht gefunden' }))
  await v.toggle({ label: /Dateien \(2\)/ })
  assert.ok(v.find({ text: 'geändert: src/cart.tsx' }) && v.find({ text: 'neu: src/hero.tsx' }))
  await v.toggle({ type: 'Collapsible', label: 'Einstellungen' })
  const lang = v.find({ type: 'Select', label: 'Sprache' })
  assert.ok(lang)
  assert.equal(v.valueOf(lang), 'de')
  const options = lang.props.options as { value: string; label: string }[]
  assert.deepEqual(options.map((o) => o.label), ['Automatisch', 'English', 'Deutsch', 'Español'])
  assert.ok(v.find({ type: 'Select', label: 'Aktualisieren, solange das Panel offen ist' }))
  assert.ok(v.find({ type: 'Switch', label: 'Benachrichtigen, wenn ein Agent fertig ist und offene Arbeit hinterlässt' }))
  assert.equal(v.find({ text: 'Current session' }), null)
  assert.deepEqual(v.errors, [])
})

t('the language setting es draws the panel in Spanish', async () => {
  const v = await openIn('es', 'de-DE')
  assert.ok(v.find({ text: '1 worktree con archivos sin confirmar' }))
  assert.ok(v.find({ text: 'Sesión actual' }))
  assert.ok(v.find({ text: 'Archivos sin confirmar' }))
  assert.ok(v.find({ text: 'Todos 3' }) && v.find({ text: 'Sin confirmar 1' }))
  assert.ok(v.find({ text: '3 cambiados' }) && v.find({ text: '2 sin push' }) && v.find({ text: '1 conflicto' }) && v.find({ text: 'limpio' }))
  assert.ok(v.findAll({ text: 'Abrir' }).length >= 1 && v.findAll({ text: 'Ocultar' }).length >= 1)
  await v.toggle({ type: 'Collapsible', label: 'Sin revisar' })
  assert.ok(v.find({ text: 'carpeta no encontrada' }))
  await v.toggle({ type: 'Collapsible', label: 'Ajustes' })
  const lang = v.find({ type: 'Select', label: 'Idioma' })
  assert.ok(lang)
  assert.deepEqual((lang.props.options as { label: string }[]).map((o) => o.label), ['Automático', 'English', 'Deutsch', 'Español'])
  assert.ok(v.find({ type: 'Select', label: 'Actualizar la barra de estado en segundo plano' }))
})

t('auto follows Orca\'s locale: de-DE is German, es-MX Spanish, fr English', async () => {
  await assertGerman(await openIn('auto', 'de-DE'))
  const es = await openIn('auto', 'es-MX')
  assert.ok(es.find({ text: 'Sesión actual' }))
  const fr = await openIn('auto', 'fr-FR')
  assert.ok(fr.find({ text: 'Current session' }))
  assert.ok(fr.find({ text: '3 changed' }))
})

t('the panel tells the worker Orca\'s locale at the start', async () => {
  const sent: string[] = []
  await openIn('auto', 'es-MX', { 'ui.locale': (input: { locale: string }) => { sent.push(input.locale); return { ok: true } } })
  assert.deepEqual(sent, ['es-MX'])
})

t('choosing a language in the settings saves it and redraws the panel', async () => {
  const sent: unknown[] = []
  const host = mockHost({
    requests: {
      'sessions.get': state(many),
      'sessions.refresh': state(many),
      'config.get': cfg,
      'config.set': (input) => {
        sent.push(input)
        return { ...cfg, ...input }
      }
    }
  })
  const v = await mount(panel, { host, locale: 'en-US' })
  views.push(v)
  await v.toggle({ type: 'Collapsible', label: 'Settings' })
  const lang = v.find({ type: 'Select', label: 'Language' })
  assert.ok(lang)
  assert.equal(v.valueOf(lang), 'auto')
  assert.deepEqual((lang.props.options as { label: string }[]).map((o) => o.label), ['Automatic', 'English', 'Deutsch', 'Español'])
  await v.select(lang, 'es')
  assert.deepEqual(sent, [{ language: 'es' }])
  assert.ok(v.find({ text: 'Sesión actual' }))
  assert.ok(v.find({ type: 'Select', label: 'Idioma' }))
})

t('worker errors are shown in the panel language, unknown texts as they are', async () => {
  const v = await openIn('de', 'en-US', {
    'session.hide': () => {
      throw new Error('This worktree still has open work and cannot be hidden')
    },
    'session.open': () => {
      throw new Error('odd <b>text</b>')
    }
  })
  await v.press(v.findAll({ text: 'Ausblenden' })[0])
  assert.ok(v.find({ text: 'Dieser Worktree hat noch offene Arbeit und lässt sich nicht ausblenden' }))
  await v.press(v.findAll({ text: 'Öffnen' })[0])
  assert.ok(v.find({ text: 'odd <b>text</b>' }))
})

// Files that must not be committed

const leaky: Session = {
  ...base, id: 'w9', name: 'api', verdict: 'keep', reasons: ['1 sensitive file not ignored', '1 secret in repo'], untracked: 1, files: [{ state: '??', path: '.env' }],
  sensitive: [
    { path: 'deploy/prod.pem', kind: 'secret', tracked: true, rule: '*.pem' },
    { path: '.env', kind: 'secret', tracked: false, rule: '.env' },
    { path: 'node_modules/', kind: 'junk', tracked: false, rule: 'node_modules/' }
  ],
  sensitiveCount: 5, sensitiveSecrets: 2, sensitiveTracked: 1
}
async function openLeaky(language: Config['language']) {
  const host = mockHost({ requests: { 'sessions.get': state([leaky, safe]), 'sessions.refresh': state([leaky, safe]), 'config.get': { ...cfg, language }, 'ui.locale': { ok: true } } })
  const v = await mount(panel, { host, locale: 'en-US' })
  views.push(v)
  return v
}

t('a card with a secret shows red chips and the Do not commit block', async () => {
  const v = await openLeaky('en')
  assert.ok(v.find({ text: '1 sensitive file' }))
  assert.ok(v.find({ text: '1 secret in repo' }))
  assert.ok(v.find({ text: 'junk files' }))
  // no uncommitted files: the worktree is in Keep open
  assert.ok(v.find({ text: 'Keep open' }))
  await v.toggle({ label: /Files/ })
  assert.ok(v.find({ text: 'Do not commit' }))
  assert.ok(v.find({ text: 'deploy/prod.pem (already tracked)' }))
  assert.ok(v.find({ text: '.env (not ignored)' }))
  assert.ok(v.find({ text: 'node_modules/ (not ignored)' }))
  assert.ok(v.find({ text: '…and 2 more' }))
  assert.deepEqual(v.errors, [])
})

t('the Do not commit block in German and Spanish', async () => {
  const de = await openLeaky('de')
  assert.ok(de.find({ text: '1 sensible Datei' }) && de.find({ text: '1 Geheimnis im Repo' }) && de.find({ text: 'Datenmüll' }))
  assert.ok(de.find({ text: 'Offen lassen' }))
  await de.toggle({ label: /Dateien/ })
  assert.ok(de.find({ text: 'Nicht committen' }))
  assert.ok(de.find({ text: 'deploy/prod.pem (schon versioniert)' }) && de.find({ text: '.env (nicht ignoriert)' }))
  assert.ok(de.find({ text: '…und 2 weitere' }))
  await de.unmount()
  const es = await openLeaky('es')
  assert.ok(es.find({ text: '1 archivo sensible' }) && es.find({ text: '1 secreto en el repo' }) && es.find({ text: 'archivos basura' }))
  await es.toggle({ label: /Archivos/ })
  assert.ok(es.find({ text: 'No hacer commit' }))
  assert.ok(es.find({ text: 'deploy/prod.pem (ya versionado)' }) && es.find({ text: '.env (no ignorado)' }))
  assert.ok(es.find({ text: '…y 2 más' }))
})

t('a card with uncommitted files and a secret is in Uncommitted files; Details opens without changed files', async () => {
  const both: Session = { ...leaky, uncommitted: 2, files: [] }
  const onlyTracked: Session = { ...base, id: 'w8', name: 'keys', verdict: 'keep', sensitive: [{ path: 'id_rsa', kind: 'secret', tracked: true, rule: 'id_rsa' }], sensitiveCount: 1, sensitiveSecrets: 1, sensitiveTracked: 1 }
  const host = mockHost({ requests: { 'sessions.get': state([both, onlyTracked]), 'sessions.refresh': state([both, onlyTracked]), 'config.get': cfg } })
  const v = await open(host)
  assert.ok(v.find({ text: 'Uncommitted files' }))
  assert.ok(v.find({ text: 'Keep open' }))
  for (const d of v.findAll({ type: 'Collapsible', label: 'Details' })) await v.toggle(d)
  assert.ok(v.find({ text: 'id_rsa (already tracked)' }))
})

t('the sensitive warning switch is in the settings and saves', async () => {
  const sent: unknown[] = []
  const host = mockHost({
    requests: {
      'sessions.get': state([safe]),
      'sessions.refresh': state([safe]),
      'config.get': cfg,
      'config.set': (input) => {
        sent.push(input)
        return { ...cfg, ...input }
      }
    }
  })
  const view = await open(host)
  await view.toggle({ type: 'Collapsible', label: 'Settings' })
  const label = 'Warn about files that must not be committed (by name only)'
  assert.equal(view.valueOf({ type: 'Switch', label }), true)
  await view.toggle({ type: 'Switch', label })
  assert.deepEqual(sent, [{ warnSensitive: false }])
  assert.equal(view.valueOf({ type: 'Switch', label }), false)
})
