// Texts of the panel, the status bar and the notification in English, German and Spanish (pure, no I/O).
// Values from git or the workspace (names, branches, paths) only go in as {placeholders}, as plain text.

export type Lang = 'en' | 'de' | 'es'
export const LANGS: readonly Lang[] = ['en', 'de', 'es']
/** What the language setting may hold; anything else counts as auto */
export type LanguageSetting = 'auto' | Lang
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['auto', 'en', 'de', 'es']
/** Names of the choices; the language names are never translated */
export const LANGUAGE_NAMES: Record<Lang, string> = { en: 'English', de: 'Deutsch', es: 'Español' }

/** One text, or a singular and a plural form chosen by the param `n` */
export type Text = string | { one: string; other: string }
type Entry = Record<Lang, Text>

const DICT = {
  // Panel
  'panel.loading': { en: 'Loading', de: 'Wird geladen', es: 'Cargando' },
  'panel.rescan': { en: 'Rescan worktrees', de: 'Worktrees neu scannen', es: 'Volver a escanear worktrees' },
  'panel.dirtyCount': {
    en: { one: '{n} worktree with uncommitted files', other: '{n} worktrees with uncommitted files' },
    de: { one: '{n} Worktree mit nicht committeten Dateien', other: '{n} Worktrees mit nicht committeten Dateien' },
    es: { one: '{n} worktree con archivos sin confirmar', other: '{n} worktrees con archivos sin confirmar' }
  },
  'panel.allCommitted': { en: 'Everything is committed', de: 'Alles ist committet', es: 'Todo está confirmado' },
  'panel.truncated': {
    en: 'Only the first {n} workspaces are checked.',
    de: 'Nur die ersten {n} Workspaces werden geprüft.',
    es: 'Solo se revisan los primeros {n} workspaces.'
  },
  'panel.current': { en: 'Current session', de: 'Aktuelle Session', es: 'Sesión actual' },
  'filter.all': { en: 'All {n}', de: 'Alle {n}', es: 'Todos {n}' },
  'filter.changes': { en: 'Uncommitted {n}', de: 'Nicht committet {n}', es: 'Sin confirmar {n}' },
  'filter.safe': { en: 'Can close {n}', de: 'Schließbar {n}', es: 'Se pueden cerrar {n}' },
  'search.label': { en: 'Search worktrees', de: 'Worktrees suchen', es: 'Buscar worktrees' },
  'search.placeholder': { en: 'Search project, worktree or branch', de: 'Projekt, Worktree oder Branch suchen', es: 'Buscar proyecto, worktree o branch' },
  'group.by': { en: 'Group by', de: 'Gruppieren nach', es: 'Agrupar por' },
  'group.status': { en: 'status', de: 'Status', es: 'estado' },
  'group.project': { en: 'project', de: 'Projekt', es: 'proyecto' },
  'group.noProject': { en: '(no project)', de: '(kein Projekt)', es: '(sin proyecto)' },
  'group.dirty': { en: 'Uncommitted files', de: 'Nicht committete Dateien', es: 'Archivos sin confirmar' },
  'group.keep': { en: 'Keep open', de: 'Offen lassen', es: 'Mantener abierto' },
  'group.check': { en: 'Check first', de: 'Erst prüfen', es: 'Revisar primero' },
  'group.safe': { en: 'Can close', de: 'Schließbar', es: 'Se puede cerrar' },
  'group.unknown': { en: 'Not checked', de: 'Nicht geprüft', es: 'Sin revisar' },
  'empty.none.title': { en: 'No workspaces', de: 'Keine Workspaces', es: 'No hay workspaces' },
  'empty.none.text': { en: 'Add a workspace in Orca, then rescan.', de: 'Workspace in Orca hinzufügen, dann neu scannen.', es: 'Añade un workspace en Orca y vuelve a escanear.' },
  'empty.filter.title': { en: 'Nothing matches', de: 'Keine Treffer', es: 'Sin resultados' },
  'empty.filter.text': { en: 'No worktree fits the filter.', de: 'Kein Worktree passt zum Filter.', es: 'Ningún worktree coincide con el filtro.' },
  'hidden.hide': { en: 'Hide hidden worktrees', de: 'Ausgeblendete Worktrees verbergen', es: 'Ocultar worktrees ocultos' },
  'hidden.show': { en: 'Show hidden worktrees ({n})', de: 'Ausgeblendete Worktrees zeigen ({n})', es: 'Mostrar worktrees ocultos ({n})' },
  'panel.footer': {
    en: 'Unpushed and behind use the last known upstream. Nothing is fetched.',
    de: 'Ungepusht und zurück: Stand des zuletzt bekannten Upstreams. Es wird nichts gefetcht.',
    es: 'Sin push y por detrás: según el último upstream conocido. No se hace fetch.'
  },
  // Card
  'card.open': { en: 'Open', de: 'Öffnen', es: 'Abrir' },
  'card.show': { en: 'Show', de: 'Einblenden', es: 'Mostrar' },
  'card.hide': { en: 'Hide', de: 'Ausblenden', es: 'Ocultar' },
  'card.detached': { en: 'detached HEAD', de: 'Detached HEAD', es: 'HEAD separado' },
  'card.oldestChange': { en: 'oldest change', de: 'älteste Änderung', es: 'cambio más antiguo' },
  'card.commit': { en: 'commit', de: 'Commit', es: 'commit' },
  'card.active': { en: 'active', de: 'aktiv', es: 'activo' },
  'card.files': { en: 'Files ({n})', de: 'Dateien ({n})', es: 'Archivos ({n})' },
  'card.details': { en: 'Details', de: 'Details', es: 'Detalles' },
  'card.unpushed': { en: 'Unpushed: {n}', de: 'Ungepusht: {n}', es: 'Sin push: {n}' },
  'card.more': { en: '…and {n} more', de: '…und {n} weitere', es: '…y {n} más' },
  'card.staged': {
    en: { one: '{n} of the changed files staged', other: '{n} of the changed files staged' },
    de: { one: '{n} der geänderten Dateien gestaged', other: '{n} der geänderten Dateien gestaged' },
    es: { one: '{n} de los archivos cambiados en stage', other: '{n} de los archivos cambiados en stage' }
  },
  'card.upstream': { en: 'upstream {name}', de: 'Upstream {name}', es: 'upstream {name}' },
  'card.otherStash': {
    en: { one: '{n} stash entry on other branches', other: '{n} stash entries on other branches' },
    de: { one: '{n} Stash-Eintrag auf anderen Branches', other: '{n} Stash-Einträge auf anderen Branches' },
    es: { one: '{n} entrada de stash en otras branches', other: '{n} entradas de stash en otras branches' }
  },
  'card.doNotCommit': { en: 'Do not commit', de: 'Nicht committen', es: 'No hacer commit' },
  'card.notIgnored': { en: '{path} (not ignored)', de: '{path} (nicht ignoriert)', es: '{path} (no ignorado)' },
  'card.alreadyTracked': { en: '{path} (already tracked)', de: '{path} (schon versioniert)', es: '{path} (ya versionado)' },
  'card.allMerged': { en: 'all commits are already in the base branch', de: 'alle Commits sind schon im Basis-Branch', es: 'todos los commits ya están en la branch base' },
  // Chips
  'chip.changed': {
    en: { one: '{n} changed', other: '{n} changed' },
    de: { one: '{n} geändert', other: '{n} geändert' },
    es: { one: '{n} cambiado', other: '{n} cambiados' }
  },
  'chip.conflicts': {
    en: { one: '{n} conflict', other: '{n} conflicts' },
    de: { one: '{n} Konflikt', other: '{n} Konflikte' },
    es: { one: '{n} conflicto', other: '{n} conflictos' }
  },
  'chip.unpushed': { en: '{n} unpushed', de: '{n} ungepusht', es: '{n} sin push' },
  'chip.agentWorking': { en: 'agent working', de: 'Agent arbeitet', es: 'agente trabajando' },
  'chip.agentWaits': { en: 'agent waits', de: 'Agent wartet', es: 'agente esperando' },
  'chip.operation': { en: '{op}', de: '{op} läuft', es: '{op} en curso' },
  'chip.untracked': { en: '{n} untracked', de: '{n} nicht versioniert', es: '{n} sin seguimiento' },
  'chip.stash': { en: '{n} stash', de: '{n} Stash', es: '{n} stash' },
  'chip.merged': { en: 'merged', de: 'gemergt', es: 'fusionado' },
  'chip.detached': { en: 'detached', de: 'Detached HEAD', es: 'HEAD separado' },
  'chip.upstreamGone': { en: 'upstream gone', de: 'Upstream fehlt', es: 'upstream eliminado' },
  'chip.noUpstream': { en: 'no upstream', de: 'kein Upstream', es: 'sin upstream' },
  'chip.submodules': { en: 'submodules not checked', de: 'Submodule nicht geprüft', es: 'submódulos sin revisar' },
  'chip.behind': { en: '{n} behind', de: '{n} zurück', es: '{n} por detrás' },
  'chip.agentUnknown': { en: 'agent unknown', de: 'Agent unbekannt', es: 'agente desconocido' },
  'chip.sensitive': {
    en: { one: '{n} sensitive file', other: '{n} sensitive files' },
    de: { one: '{n} sensible Datei', other: '{n} sensible Dateien' },
    es: { one: '{n} archivo sensible', other: '{n} archivos sensibles' }
  },
  'chip.secretInRepo': {
    en: { one: '{n} secret in repo', other: '{n} secrets in repo' },
    de: { one: '{n} Geheimnis im Repo', other: '{n} Geheimnisse im Repo' },
    es: { one: '{n} secreto en el repo', other: '{n} secretos en el repo' }
  },
  'chip.junk': { en: 'junk files', de: 'Datenmüll', es: 'archivos basura' },
  'chip.clean': { en: 'clean', de: 'sauber', es: 'limpio' },
  'chip.prOpen': { en: 'PR #{n} open', de: 'PR #{n} offen', es: 'PR #{n} abierta' },
  'chip.prDraft': { en: 'PR #{n} draft', de: 'PR #{n} Entwurf', es: 'PR #{n} borrador' },
  'chip.prMerged': { en: 'PR #{n} merged', de: 'PR #{n} gemergt', es: 'PR #{n} fusionada' },
  'chip.prClosed': { en: 'PR #{n} closed', de: 'PR #{n} geschlossen', es: 'PR #{n} cerrada' },
  // File states (git's two-letter code as a word)
  'file.new': { en: 'new', de: 'neu', es: 'nuevo' },
  'file.conflict': { en: 'conflict', de: 'Konflikt', es: 'conflicto' },
  'file.edited': { en: 'edited', de: 'geändert', es: 'editado' },
  'file.added': { en: 'added', de: 'hinzugefügt', es: 'añadido' },
  'file.deleted': { en: 'deleted', de: 'gelöscht', es: 'eliminado' },
  'file.renamed': { en: 'renamed', de: 'umbenannt', es: 'renombrado' },
  'file.copied': { en: 'copied', de: 'kopiert', es: 'copiado' },
  'file.typeChanged': { en: 'type changed', de: 'Typ geändert', es: 'tipo cambiado' },
  'file.staged': { en: '{what}, staged', de: '{what}, gestaged', es: '{what}, en stage' },
  'file.stagedAndOpen': { en: '{what}, staged + {open}', de: '{what}, gestaged + {open}', es: '{what}, en stage + {open}' },
  // Settings
  'settings.title': { en: 'Settings', de: 'Einstellungen', es: 'Ajustes' },
  'settings.description': {
    en: 'base branch, refresh, notifications, sensitive files, pull requests, language',
    de: 'Basis-Branch, Aktualisierung, Benachrichtigungen, sensible Dateien, Pull Requests, Sprache',
    es: 'branch base, actualización, avisos, archivos sensibles, pull requests, idioma'
  },
  'settings.base': { en: 'Base branch (empty = detect from origin/HEAD)', de: 'Basis-Branch (leer = aus origin/HEAD erkennen)', es: 'Branch base (vacío = detectar desde origin/HEAD)' },
  'settings.basePlaceholder': { en: 'e.g. origin/main', de: 'z. B. origin/main', es: 'p. ej. origin/main' },
  'settings.interval': { en: 'Refresh while the panel is open', de: 'Aktualisieren, solange das Panel offen ist', es: 'Actualizar con el panel abierto' },
  'settings.every': {
    en: { one: 'every {n} second', other: 'every {n} seconds' },
    de: { one: 'alle {n} Sekunde', other: 'alle {n} Sekunden' },
    es: { one: 'cada {n} segundo', other: 'cada {n} segundos' }
  },
  'settings.background': { en: 'Status bar refresh in the background', de: 'Statusleiste im Hintergrund aktualisieren', es: 'Actualizar la barra de estado en segundo plano' },
  'settings.backgroundOff': { en: 'off (events only)', de: 'aus (nur bei Ereignissen)', es: 'desactivado (solo con eventos)' },
  'settings.notify': {
    en: 'Notify when an agent finishes and leaves open work',
    de: 'Benachrichtigen, wenn ein Agent fertig ist und offene Arbeit hinterlässt',
    es: 'Avisar cuando un agente termine y deje trabajo abierto'
  },
  'settings.warnSensitive': {
    en: 'Warn about files that must not be committed (by name only)',
    de: 'Vor Dateien warnen, die nicht ins Repo gehören (nur nach dem Namen)',
    es: 'Avisar de archivos que no deben ir al repo (solo por el nombre)'
  },
  'settings.showPullRequests': {
    en: 'Show GitHub pull requests (asks gh, uses the network)',
    de: 'GitHub-Pull-Requests anzeigen (fragt gh, nutzt das Netzwerk)',
    es: 'Mostrar pull requests de GitHub (consulta gh, usa la red)'
  },
  'settings.language': { en: 'Language', de: 'Sprache', es: 'Idioma' },
  'settings.languageAuto': { en: 'Automatic', de: 'Automatisch', es: 'Automático' },
  // Status bar and notification (worker)
  'bar.unknownAll': { en: 'Sessions ?', de: 'Sessions ?', es: 'Sesiones ?' },
  'bar.open': { en: 'Sessions {n} open', de: 'Sessions {n} offen', es: 'Sesiones {n} abiertas' },
  'bar.unchecked': { en: 'Sessions {n} unchecked', de: 'Sessions {n} ungeprüft', es: 'Sesiones {n} sin revisar' },
  'bar.ok': { en: 'Sessions ok', de: 'Sessions ok', es: 'Sesiones ok' },
  'bar.tip.unknownAll': { en: 'Session Check: no worktree could be checked', de: 'Session Check: kein Worktree konnte geprüft werden', es: 'Session Check: no se pudo revisar ningún worktree' },
  'bar.tip.listFailed': { en: 'Session Check: could not list the workspaces', de: 'Session Check: Workspaces konnten nicht gelesen werden', es: 'Session Check: no se pudieron listar los workspaces' },
  'bar.tip.open': { en: 'Uncommitted files: {names}', de: 'Nicht committete Dateien: {names}', es: 'Archivos sin confirmar: {names}' },
  'bar.tip.more': { en: '+{n} more', de: '+{n} weitere', es: '+{n} más' },
  'bar.tip.unchecked': {
    en: { one: 'Session Check: nothing uncommitted, {n} worktree could not be checked', other: 'Session Check: nothing uncommitted, {n} worktrees could not be checked' },
    de: { one: 'Session Check: nichts offen, {n} Worktree konnte nicht geprüft werden', other: 'Session Check: nichts offen, {n} Worktrees konnten nicht geprüft werden' },
    es: { one: 'Session Check: nada sin confirmar, no se pudo revisar {n} worktree', other: 'Session Check: nada sin confirmar, no se pudieron revisar {n} worktrees' }
  },
  'bar.tip.ok': { en: 'Session Check: every worktree is committed', de: 'Session Check: alle Worktrees sind committet', es: 'Session Check: todos los worktrees están confirmados' },
  'notify.done': { en: '{label}: agent finished, {parts}', de: '{label}: Agent fertig, {parts}', es: '{label}: agente terminado, {parts}' },
  'notify.uncommitted': {
    en: { one: '{n} file uncommitted', other: '{n} files uncommitted' },
    de: { one: '{n} Datei nicht committet', other: '{n} Dateien nicht committet' },
    es: { one: '{n} archivo sin confirmar', other: '{n} archivos sin confirmar' }
  },
  'notify.untracked': {
    en: { one: '{n} new file', other: '{n} new files' },
    de: { one: '{n} neue Datei', other: '{n} neue Dateien' },
    es: { one: '{n} archivo nuevo', other: '{n} archivos nuevos' }
  },
  'notify.unpushed': {
    en: { one: '{n} commit unpushed', other: '{n} commits unpushed' },
    de: { one: '{n} Commit ungepusht', other: '{n} Commits ungepusht' },
    es: { one: '{n} commit sin push', other: '{n} commits sin push' }
  },
  'notify.sensitive': {
    en: { one: '{n} sensitive file', other: '{n} sensitive files' },
    de: { one: '{n} sensible Datei', other: '{n} sensible Dateien' },
    es: { one: '{n} archivo sensible', other: '{n} archivos sensibles' }
  },
  'command.refreshed': {
    en: { one: '{n} worktree', other: '{n} worktrees' },
    de: { one: '{n} Worktree', other: '{n} Worktrees' },
    es: { one: '{n} worktree', other: '{n} worktrees' }
  },
  // Errors and reasons that reach the panel (the worker sends the English text, it is the stable code)
  'err.folderWorkspace': { en: 'folder workspace, not checked', de: 'Ordner-Workspace, nicht geprüft', es: 'workspace de carpeta, sin revisar' },
  'err.remoteWorkspace': { en: 'remote workspace, not checked', de: 'Remote-Workspace, nicht geprüft', es: 'workspace remoto, sin revisar' },
  'err.invalidPath': { en: 'invalid path', de: 'ungültiger Pfad', es: 'ruta no válida' },
  'err.notCheckedYet': { en: 'not checked yet', de: 'noch nicht geprüft', es: 'aún sin revisar' },
  'err.folderNotFound': { en: 'folder not found', de: 'Ordner nicht gefunden', es: 'carpeta no encontrada' },
  'err.unsafeConfig': { en: 'repository config not safe to read', de: 'Repository-Config nicht sicher lesbar', es: 'la config del repositorio no es segura de leer' },
  'err.partialClone': { en: 'partial clone, not checked', de: 'Partial Clone, nicht geprüft', es: 'partial clone, sin revisar' },
  'err.statusFailed': { en: 'git status failed', de: 'git status fehlgeschlagen', es: 'git status falló' },
  'err.notRepo': { en: 'not a git repository (or git refused it)', de: 'kein Git-Repository (oder Git hat es abgelehnt)', es: 'no es un repositorio git (o git lo rechazó)' },
  'err.stashFailed': { en: 'git stash list failed', de: 'git stash list fehlgeschlagen', es: 'git stash list falló' },
  'err.gitMissing': { en: 'git is not installed', de: 'Git ist nicht installiert', es: 'git no está instalado' },
  'err.gitTimeout': { en: 'git timed out', de: 'Git hat zu lange gebraucht', es: 'git tardó demasiado' },
  'err.gitTooLarge': { en: 'git output too large', de: 'Git-Ausgabe zu groß', es: 'salida de git demasiado grande' },
  'err.gitFailed': { en: 'git failed', de: 'Git fehlgeschlagen', es: 'git falló' },
  'err.listFailed': { en: 'Could not list the workspaces', de: 'Workspaces konnten nicht gelesen werden', es: 'No se pudieron listar los workspaces' },
  'err.cannotHide': {
    en: 'This worktree still has open work and cannot be hidden',
    de: 'Dieser Worktree hat noch offene Arbeit und lässt sich nicht ausblenden',
    es: 'Este worktree aún tiene trabajo abierto y no se puede ocultar'
  },
  'err.unknownWorkspace': { en: 'Unknown workspace', de: 'Unbekannter Workspace', es: 'Workspace desconocido' },
  'err.invalidRequest': { en: 'Invalid request', de: 'Ungültige Anfrage', es: 'Solicitud no válida' },
  'err.openFailed': { en: 'Could not open the workspace', de: 'Workspace konnte nicht geöffnet werden', es: 'No se pudo abrir el workspace' }
} satisfies Record<string, Entry>

export type MsgKey = keyof typeof DICT
export const MESSAGES: Readonly<Record<MsgKey, Entry>> = DICT
export type Params = Record<string, string | number>

const isLang = (v: unknown): v is Lang => v === 'en' || v === 'de' || v === 'es'

/** The setting as stored: an unknown value counts as auto */
export function languageSetting(value: unknown): LanguageSetting {
  return isLang(value) ? value : 'auto'
}

/** An explicit language wins; auto takes the language of the locale ("de-DE" -> de), anything else is English */
export function resolveLang(setting: unknown, uiLocale: unknown): Lang {
  if (isLang(setting)) return setting
  if (typeof uiLocale !== 'string') return 'en'
  const base = uiLocale.trim().split(/[-_]/)[0]?.toLowerCase()
  return isLang(base) ? base : 'en'
}

/** en, de and es: 1 is singular, everything else (0 too) plural */
function pick(text: Text, n: unknown): string {
  if (typeof text === 'string') return text
  return n === 1 ? text.one : text.other
}

/** The text in that language with {placeholders} filled in once as plain text; never throws */
export function tr(lang: Lang, key: MsgKey, params?: Params): string {
  const entry = (MESSAGES as Readonly<Record<string, Entry | undefined>>)[key]
  if (!entry) return String(key)
  const text = (isLang(lang) ? entry[lang] : undefined) ?? entry.en
  const raw = pick(text, params?.n)
  if (!params) return raw
  // One pass: a value that contains "{x}" is not filled in again
  return raw.replace(/\{(\w+)\}/g, (all, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : all))
}

// The English texts of errors are the codes the worker sends; this maps them back to their key
const ERROR_KEYS = new Map<string, MsgKey>(
  (Object.keys(DICT) as MsgKey[]).filter((k) => k.startsWith('err.')).map((k) => [DICT[k].en as string, k])
)

/** The key of a known error text from the worker, null for anything else */
export function errorKey(text: unknown): MsgKey | null {
  if (typeof text !== 'string') return null
  const exact = ERROR_KEYS.get(text)
  if (exact) return exact
  // A transport may put a prefix in front ("Error: ...")
  for (const [en, key] of ERROR_KEYS) if (text.endsWith(`: ${en}`)) return key
  return null
}

/** A known error in that language, anything else as it is */
export function errorText(lang: Lang, text: string): string {
  const key = errorKey(text)
  return key ? tr(lang, key) : text
}
