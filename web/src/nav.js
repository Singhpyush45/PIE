import { useCallback, useState } from 'react';

/* PIE navigation — a real view stack.
   Back returns to the previous APP VIEW, not to browser history, so deep flows
   (Compare → Candidate → Assessment → Device check) unwind the way a user
   expects even though the app is a single page. */

export const VIEWS = {
  /* --- candidate --- */
  'c-dash':       { title: 'Dashboard',            section: 'My potential', role: 'candidate', icon: 'dashboard' },
  'c-profile':    { title: 'Profile',              section: 'My potential', role: 'candidate', icon: 'user', parent: 'c-dash' },
  'c-evidence':   { title: 'Evidence',             section: 'My potential', role: 'candidate', icon: 'file', parent: 'c-dash' },
  'c-import':     { title: 'Import evidence',      section: 'My potential', role: 'candidate', icon: 'plug', parent: 'c-evidence', hidden: true },
  'c-jobs':       { title: 'Discover jobs',        section: 'Opportunities', role: 'candidate', icon: 'brief' },
  'c-job':        { title: 'Role',                 section: 'Opportunities', role: 'candidate', icon: 'brief', parent: 'c-jobs', hidden: true },
  'c-apps':       { title: 'Applications',         section: 'Opportunities', role: 'candidate', icon: 'layers' },
  'c-learning':   { title: 'Learning pathway',     section: 'Grow', role: 'candidate', icon: 'learn' },
  'c-assess':     { title: 'Assessment',           section: 'Grow', role: 'candidate', icon: 'target' },
  'c-match':      { title: 'My match',             section: 'Grow', role: 'candidate', icon: 'match', parent: 'c-dash', hidden: true },

  /* --- recruiter --- */
  'r-overview':   { title: 'Overview',             section: 'Talent intelligence', role: 'recruiter', icon: 'dashboard' },
  'r-pool':       { title: 'Candidate pool',       section: 'Talent intelligence', role: 'recruiter', icon: 'users' },
  'r-candidate':  { title: 'Candidate profile',    section: 'Talent intelligence', role: 'recruiter', icon: 'user', parent: 'r-pool', hidden: true },
  'r-compare':    { title: 'Compare candidates',   section: 'Talent intelligence', role: 'recruiter', icon: 'scale' },
  'r-reqs':       { title: 'Requisitions',         section: 'Requisitions', role: 'recruiter', icon: 'brief' },
  'r-req':        { title: 'Requisition',          section: 'Requisitions', role: 'recruiter', icon: 'brief', parent: 'r-reqs', hidden: true },
  'r-req-new':    { title: 'New requisition',      section: 'Requisitions', role: 'recruiter', icon: 'market', parent: 'r-reqs', hidden: true },
  'r-orchestrator': { title: 'Orchestrator run',   section: 'Governance', role: 'recruiter', icon: 'orchestr' },
  'r-bias':       { title: 'Bias audit',           section: 'Governance', role: 'recruiter', icon: 'shield' },
  'r-audit':      { title: 'Audit trail',          section: 'Governance', role: 'recruiter', icon: 'history' },

  /* --- admin --- */
  'a-overview':   { title: 'Overview',             section: 'Trust & integrity', role: 'admin', icon: 'dashboard' },
  'a-bias':       { title: 'Bias reviews',         section: 'Trust & integrity', role: 'admin', icon: 'shield' },
  'a-attempts':   { title: 'Assessment integrity', section: 'Trust & integrity', role: 'admin', icon: 'lock' },
  'a-proctoring': { title: 'Proctoring events',    section: 'Trust & integrity', role: 'admin', icon: 'camera' },
  'a-decisions':  { title: 'Human decisions',      section: 'Governance', role: 'admin', icon: 'user' },
  'a-audit':      { title: 'Audit trail',          section: 'Governance', role: 'admin', icon: 'history' },
  'a-people':     { title: 'People & roles',       section: 'Governance', role: 'admin', icon: 'users' },

  /* --- shared --- */
  'sap':          { title: 'SAP integration readiness', section: 'Platform', role: '*', icon: 'plug' },
  'demo':         { title: 'Grand Finale demo',    section: 'Platform', role: '*', icon: 'play' },
};

export const HOME = { candidate: 'c-dash', recruiter: 'r-overview', admin: 'a-overview' };

export function navFor(role) {
  const groups = new Map();
  for (const [key, v] of Object.entries(VIEWS)) {
    if (v.hidden) continue;
    if (v.role !== '*' && v.role !== role) continue;
    if (!groups.has(v.section)) groups.set(v.section, []);
    groups.get(v.section).push({ key, ...v });
  }
  return [...groups.entries()].map(([section, items]) => ({ section, items }));
}

/** Breadcrumb trail for a view, following the `parent` chain. */
export function crumbsFor(view, params = {}) {
  const out = [];
  let cur = view;
  const guard = new Set();
  while (cur && VIEWS[cur] && !guard.has(cur)) {
    guard.add(cur);
    out.unshift({ key: cur, title: params[`${cur}Title`] || VIEWS[cur].title });
    cur = VIEWS[cur].parent;
  }
  const section = VIEWS[view]?.section;
  if (section) out.unshift({ key: null, title: section });
  return out;
}

export function useNavStack(initial) {
  const [stack, setStack] = useState([{ view: initial, params: {} }]);
  const current = stack[stack.length - 1];

  const push = useCallback((view, params = {}) => {
    setStack(s => {
      const top = s[s.length - 1];
      if (top.view === view && JSON.stringify(top.params) === JSON.stringify(params)) return s;
      return [...s, { view, params }];
    });
  }, []);

  /** Sidebar navigation resets the stack — it is a new journey, not a deeper one. */
  const go = useCallback((view, params = {}) => setStack([{ view, params }]), []);

  const back = useCallback(() => setStack(s => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const reset = useCallback(view => setStack([{ view, params: {} }]), []);
  const setParams = useCallback(patch => setStack(s => {
    const copy = s.slice();
    copy[copy.length - 1] = { ...copy[copy.length - 1], params: { ...copy[copy.length - 1].params, ...patch } };
    return copy;
  }), []);

  return {
    view: current.view, params: current.params,
    canBack: stack.length > 1,
    previous: stack.length > 1 ? stack[stack.length - 2] : null,
    push, go, back, reset, setParams, depth: stack.length,
  };
}
