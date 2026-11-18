import { assert, test } from 'orca/testing'
import { errorKey, errorText, LANGS, languageSetting, MESSAGES, resolveLang, tr, type Lang, type MsgKey, type Text } from './i18n'

const keys = Object.keys(MESSAGES) as MsgKey[]
const forms = (t: Text): string[] => (typeof t === 'string' ? [t] : [t.one, t.other])
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')

// Names, git terms and words that are the same in that language
const SAME_AS_EN: Partial<Record<Lang, readonly MsgKey[]>> = {
  de: ['card.details', 'bar.unknownAll', 'bar.ok', 'err.statusFailed', 'err.stashFailed'],
  es: ['card.commit', 'card.upstream', 'chip.stash', 'command.refreshed', 'err.partialClone']
}

test('every key has a text in en, de and es, none empty', () => {
  assert.ok(keys.length > 50)
  for (const k of keys) {
    for (const l of LANGS) {
      const t = MESSAGES[k][l]
      assert.ok(t !== undefined, `${k} has no ${l}`)
      for (const f of forms(t)) assert.ok(f.trim().length > 0, `${k} ${l} is empty`)
    }
  }
})

test('every language and plural form has the same placeholders', () => {
  for (const k of keys) {
    const want = placeholders(forms(MESSAGES[k].en)[0])
    for (const l of LANGS) for (const f of forms(MESSAGES[k][l])) assert.equal(placeholders(f), want, `${k} ${l}: "${f}"`)
    // plural texts are counted: they need {n}
    for (const l of LANGS) if (typeof MESSAGES[k][l] !== 'string') assert.ok(want.split(',').includes('n'), `${k} is plural without {n}`)
  }
})

// Built from its code so the source holds no em dash itself
const EM_DASH = String.fromCharCode(0x2014)
// Typical stand-ins for umlauts and ß in the words these texts use
const STAND_IN = /fuer|ueber|oeffn|schliess|geaendert|aenderung|loesch|pruef|zurueck|eintraege|hinzugefuegt|ungueltig|groess|laeuft|moegl|waehl/i

test('no em dash anywhere, no stand-in umlauts in German', () => {
  for (const k of keys) {
    for (const l of LANGS) {
      for (const f of forms(MESSAGES[k][l])) {
        assert.ok(!f.includes(EM_DASH), `${k} ${l} has an em dash`)
        if (l === 'de') assert.ok(!STAND_IN.test(f), `${k} de: "${f}"`)
      }
    }
  }
  // spot checks of real umlauts and accents
  assert.equal(tr('de', 'card.open'), 'Öffnen')
  assert.equal(tr('de', 'filter.safe', { n: 2 }), 'Schließbar 2')
  assert.equal(tr('de', 'err.listFailed'), 'Workspaces konnten nicht gelesen werden')
  assert.equal(tr('es', 'panel.current'), 'Sesión actual')
  assert.equal(tr('es', 'card.hide'), 'Ocultar')
})

test('German and Spanish differ from English, except names and git terms', () => {
  for (const l of ['de', 'es'] as const) {
    for (const k of keys) {
      if (SAME_AS_EN[l]?.includes(k)) continue
      if (k === 'chip.operation') continue
      const same = forms(MESSAGES[k][l]).join('|') === forms(MESSAGES[k].en).join('|')
      assert.ok(!same, `${k} ${l} is the same as English`)
    }
  }
})

test('plural forms per language', () => {
  assert.equal(tr('en', 'notify.uncommitted', { n: 1 }), '1 file uncommitted')
  assert.equal(tr('en', 'notify.uncommitted', { n: 2 }), '2 files uncommitted')
  assert.equal(tr('en', 'notify.uncommitted', { n: 0 }), '0 files uncommitted')
  assert.equal(tr('de', 'notify.uncommitted', { n: 1 }), '1 Datei nicht committet')
  assert.equal(tr('de', 'notify.uncommitted', { n: 2 }), '2 Dateien nicht committet')
  assert.equal(tr('es', 'notify.uncommitted', { n: 1 }), '1 archivo sin confirmar')
  assert.equal(tr('es', 'notify.uncommitted', { n: 2 }), '2 archivos sin confirmar')
  assert.equal(tr('de', 'chip.conflicts', { n: 1 }), '1 Konflikt')
  assert.equal(tr('de', 'chip.conflicts', { n: 3 }), '3 Konflikte')
  assert.equal(tr('es', 'panel.dirtyCount', { n: 1 }), '1 worktree con archivos sin confirmar')
  // no count: the plural form
  assert.equal(tr('en', 'notify.untracked'), '{n} new files')
})

test('params are inserted once, as plain text', () => {
  assert.equal(tr('en', 'card.upstream', { name: '{n} <b>x</b>' }), 'upstream {n} <b>x</b>')
  assert.equal(tr('en', 'notify.done', { label: '{parts}', parts: 'p' }), '{parts}: agent finished, p')
  // a missing param stays visible instead of throwing
  assert.equal(tr('en', 'card.upstream', {}), 'upstream {name}')
})

test('unknown key or language falls back, never throws', () => {
  assert.equal(tr('en', 'nope.key' as MsgKey), 'nope.key')
  assert.equal(tr('fr' as Lang, 'card.open'), 'Open')
  assert.equal(tr(undefined as unknown as Lang, 'card.hide'), 'Hide')
})

test('resolveLang: auto follows the locale, explicit wins, garbage is auto', () => {
  assert.equal(resolveLang('auto', 'de-DE'), 'de')
  assert.equal(resolveLang('auto', 'es-MX'), 'es')
  assert.equal(resolveLang('auto', 'es_419'), 'es')
  assert.equal(resolveLang('auto', 'en-GB'), 'en')
  assert.equal(resolveLang('auto', 'fr'), 'en')
  assert.equal(resolveLang('auto', ''), 'en')
  assert.equal(resolveLang('auto', undefined), 'en')
  assert.equal(resolveLang('de', 'es-ES'), 'de')
  assert.equal(resolveLang('es', 'de-DE'), 'es')
  assert.equal(resolveLang('en', 'de-DE'), 'en')
  assert.equal(resolveLang('klingon', 'de-AT'), 'de')
  assert.equal(resolveLang(42, 'xx'), 'en')
  assert.equal(languageSetting('es'), 'es')
  assert.equal(languageSetting('ES'), 'auto')
  assert.equal(languageSetting(null), 'auto')
})

test('errors from the worker map to their key; unknown texts stay as they are', () => {
  assert.equal(errorKey('folder not found'), 'err.folderNotFound')
  assert.equal(errorKey('Error: Unknown workspace'), 'err.unknownWorkspace')
  assert.equal(errorKey('something else'), null)
  assert.equal(errorKey(5), null)
  assert.equal(errorText('de', 'git is not installed'), 'Git ist nicht installiert')
  assert.equal(errorText('es', 'Could not open the workspace'), 'No se pudo abrir el workspace')
  assert.equal(errorText('de', 'odd <text>'), 'odd <text>')
})

test('the changed chip agrees in number in Spanish', () => {
  assert.equal(tr('es', 'chip.changed', { n: 1 }), '1 cambiado')
  assert.equal(tr('es', 'chip.changed', { n: 3 }), '3 cambiados')
  assert.equal(tr('de', 'chip.changed', { n: 1 }), '1 geändert')
})

test('the sensitive file texts in every language', () => {
  assert.equal(tr('en', 'chip.sensitive', { n: 1 }), '1 sensitive file')
  assert.equal(tr('de', 'chip.sensitive', { n: 2 }), '2 sensible Dateien')
  assert.equal(tr('es', 'chip.secretInRepo', { n: 2 }), '2 secretos en el repo')
  assert.equal(tr('de', 'card.alreadyTracked', { path: '.env' }), '.env (schon versioniert)')
  assert.equal(tr('es', 'card.notIgnored', { path: '.env' }), '.env (no ignorado)')
  assert.equal(tr('de', 'settings.warnSensitive'), 'Vor Dateien warnen, die nicht ins Repo gehören (nur nach dem Namen)')
  // a path with a placeholder in its name is inserted as it is
  assert.equal(tr('en', 'card.notIgnored', { path: '{n}.pem' }), '{n}.pem (not ignored)')
})
