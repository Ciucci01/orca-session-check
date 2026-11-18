// Scenarios for `orca plugin check` and `orca plugin shot --scenario`, with demo data only
import { defineCheck } from 'orca/testing'
import type { Session, SessionsState } from './protocol'

const base: Session = {
  id: '', name: '', project: 'acme-shop', branch: 'main', current: false, hidden: false, verdict: 'safe', reasons: ['clean, nothing unpushed'],
  uncommitted: 0, staged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, upstream: 'origin/main', upstreamGone: false, submodules: false, stash: 0, stashTotal: 0,
  merged: null, operation: null, agent: null, files: [], moreFiles: 0, error: null, lastCommitAt: null, lastActiveAt: null, unpushed: [], added: null, removed: null, dirtySince: null, checkedAt: Date.now()
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
    { ...base, id: 'w3', name: 'new-footer', branch: 'feature/footer', verdict: 'check', reasons: ['2 untracked', '1 stash entry'], untracked: 2, stash: 1, stashTotal: 1, upstream: null },
    { ...base, id: 'w4', name: 'docs-update', project: 'acme-docs', branch: 'main', verdict: 'safe', behind: 4 },
    {
      ...base, id: 'w5', name: 'old-spike', project: 'acme-docs', branch: 'spike/search', verdict: 'unknown', reasons: ['folder not found'], error: 'folder not found', upstream: null
    }
  ]
}
const config = { baseBranch: '', intervalSeconds: 30 }

export default defineCheck({
  list: { requests: { 'sessions.get': state, 'config.get': config } },
  byProject: { requests: { 'sessions.get': state, 'config.get': config }, persisted: { plugin: { grouping: 'project' } } },
  empty: { requests: { 'sessions.get': { sessions: [], truncated: false, updatedAt: Date.now() }, 'config.get': config } }
})
