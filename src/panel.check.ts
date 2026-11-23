// Scenarios for `orca plugin check` and `orca plugin shot --scenario`, with demo data only
import { defineCheck } from 'orca/testing'
import type { Config, Session, SessionsState } from './protocol'

const base: Session = {
  id: '', name: '', project: 'acme-shop', branch: 'main', current: false, hidden: false, verdict: 'safe', reasons: ['clean, nothing unpushed'],
  uncommitted: 0, staged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, upstream: 'origin/main', upstreamGone: false, submodules: false, stash: 0, stashTotal: 0,
  merged: null, pr: null, operation: null, agent: null, files: [], moreFiles: 0, error: null, errorCode: null, lastCommitAt: null, lastActiveAt: null, unpushed: [], added: null, removed: null, dirtySince: null, sensitive: [], sensitiveCount: 0, sensitiveSecrets: 0, sensitiveTracked: 0, checkedAt: Date.now()
}

const state: SessionsState = {
  truncated: false,
  updatedAt: Date.now(),
  sessions: [
    {
      ...base, id: 'w1', name: 'checkout-redesign', branch: 'feature/checkout', current: true, verdict: 'keep',
      reasons: ['3 uncommitted', '2 unpushed', '1 untracked'], uncommitted: 3, staged: 1, untracked: 1, ahead: 2, upstream: 'origin/feature/checkout',
      files: [{ state: '.M', path: 'src/cart.tsx' }, { state: 'M.', path: 'src/checkout.tsx' }, { state: '??', path: 'src/hero.tsx' }]
    },
    {
      ...base, id: 'w2', name: 'fix-login', branch: 'fix/login', verdict: 'keep', reasons: ['1 uncommitted', 'agent working'], uncommitted: 1,
      agent: 'working', files: [{ state: '.M', path: 'src/auth.ts' }]
    },
    {
      ...base, id: 'w3', name: 'new-footer', branch: 'feature/footer', verdict: 'keep', reasons: ['1 sensitive file not ignored', '2 untracked', '1 stash entry'], untracked: 2, stash: 1, stashTotal: 1, upstream: null,
      files: [{ state: '??', path: '.env.local' }, { state: '??', path: 'src/footer.tsx' }],
      sensitive: [{ path: '.env.local', kind: 'secret', tracked: false, rule: '.env.*' }], sensitiveCount: 1, sensitiveSecrets: 1, sensitiveTracked: 0
    },
    { ...base, id: 'w4', name: 'docs-update', project: 'acme-docs', branch: 'main', verdict: 'safe', behind: 4 },
    {
      ...base, id: 'w5', name: 'old-spike', project: 'acme-docs', branch: 'spike/search', verdict: 'unknown', reasons: ['folder not found'], error: 'folder not found', errorCode: 'err.folderNotFound', upstream: null
    }
  ]
}
const config: Config = { baseBranch: '', intervalSeconds: 30, notifyOnAgentDone: true, backgroundSeconds: 120, language: 'auto', warnSensitive: true, showPullRequests: false }
// Pull requests turned on, with the case they explain: squash-merged, the remote branch deleted
const withPrs: SessionsState = {
  ...state,
  sessions: [
    { ...state.sessions[0], pr: { number: 42, state: 'open' } },
    { ...state.sessions[1], pr: { number: 43, state: 'draft' } },
    {
      ...base, id: 'w6', name: 'cart-badge', branch: 'feature/cart-badge', verdict: 'check', reasons: ['upstream branch is gone, has commits outside the base branch'],
      upstream: 'origin/feature/cart-badge', upstreamGone: true, merged: false, pr: { number: 38, state: 'merged' }
    },
    ...state.sessions.slice(2)
  ]
}

export default defineCheck({
  list: { requests: { 'sessions.get': state, 'config.get': config } },
  byProject: { requests: { 'sessions.get': state, 'config.get': config }, persisted: { plugin: { grouping: 'project' } } },
  german: { requests: { 'sessions.get': state, 'config.get': { ...config, language: 'de' } } },
  spanish: { requests: { 'sessions.get': state, 'config.get': { ...config, language: 'es' } } },
  pullRequests: { requests: { 'sessions.get': withPrs, 'config.get': { ...config, showPullRequests: true } } },
  empty: { requests: { 'sessions.get': { sessions: [], truncated: false, updatedAt: Date.now() }, 'config.get': config } }
})
