const BASE = '/api';
const TOKEN_KEY = 'pie-token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = t => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

async function req(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const res = await fetch(BASE + path, {
    method,
    credentials: 'include',        // the session cookie is HTTP-only
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.status = res.status; e.data = data;
    if (res.status === 401) setToken(null);
    throw e;
  }
  return data;
}

export const api = {
  /* --- platform --- */
  health: () => req('/health'),
  services: () => req('/services'),
  integrationLandscape: () => req('/integrations/landscape'),
  aiProviders: () => req('/ai/providers'),
  // Live Supabase reachability + schema check. Administrator only — it names the host.
  supabaseCheck: () => req('/system/supabase?force=1'),

  /* --- auth --- */
  // `role` is the door the user came through. The server refuses a correct
  // password presented at the wrong workspace.
  login: (identifier, password, role) =>
    req('/auth/login', { method: 'POST', body: { identifier, password, role } }),
  forgotPassword: email => req('/auth/forgot', { method: 'POST', body: { email } }),
  checkResetToken: token => req(`/auth/reset/check?token=${encodeURIComponent(token)}`),
  resetPassword: body => req('/auth/reset', { method: 'POST', body }),
  register: body => req('/auth/register', { method: 'POST', body }),

  /* Email ownership. The code itself only ever exists in the candidate's inbox
     and in the request that submits it — never in a response, never in state
     that outlives the screen. */
  requestEmailCode: email => req('/auth/verify-email/request', { method: 'POST', body: { email } }),
  confirmEmailCode: ({ email, code, ticket }) =>
    req('/auth/verify-email/confirm', { method: 'POST', body: { email, code, ticket } }),
  emailVerificationState: email =>
    req(`/auth/verify-email/state?email=${encodeURIComponent(email)}`),
  logout: () => req('/auth/logout', { method: 'POST' }),
  me: () => req('/auth/me'),
  available: q => req(`/auth/available?${new URLSearchParams(q)}`),
  bootstrap: () => req('/bootstrap'),

  /* --- demo entrance (separate door) --- */
  demoPersonas: () => req('/demo/personas'),
  demoEnter: userId => req('/demo/enter', { method: 'POST', body: { userId } }),

  /* --- candidate --- */
  candidateProfile: () => req('/candidate/profile'),
  updateProfile: body => req('/candidate/profile', { method: 'PATCH', body }),
  evidence: () => req('/candidate/evidence'),
  addEvidence: body => req('/candidate/evidence', { method: 'POST', body }),
  deleteEvidence: id => req(`/candidate/evidence/${id}`, { method: 'DELETE' }),
  addProject: body => req('/candidate/projects', { method: 'POST', body }),
  addCertificate: body => req('/candidate/certificates', { method: 'POST', body }),
  addHackathon: body => req('/candidate/hackathons', { method: 'POST', body }),
  projects: () => req('/candidate/projects'),
  uploadResume: body => req('/candidate/resume', { method: 'POST', body }),
  githubStatus: () => req('/github/status'),
  githubAuthorize: () => req('/github/authorize', { method: 'POST' }),
  githubRepositories: username =>
    req(`/github/repositories${username ? `?username=${encodeURIComponent(username)}` : ''}`),
  githubImport: body => req('/github/import', { method: 'POST', body }),
  githubDisconnect: body => req('/github/disconnect', { method: 'POST', body: body || {} }),

  // Corsair — a second, optional way to connect, and the Evidence Scout that
  // runs across whatever the candidate has authorised.
  corsairStatus: () => req('/github/corsair'),
  corsairConnect: plugin => req('/github/corsair/connect', { method: 'POST', body: { plugin } }),
  corsairDisconnect: plugin => req('/github/corsair/disconnect', { method: 'POST', body: { plugin } }),
  corsairScout: body => req('/github/corsair/scout', { method: 'POST', body: body || {} }),
  jobs: () => req('/candidate/jobs'),
  applications: () => req('/candidate/applications'),
  apply: requisitionId => req('/candidate/applications', { method: 'POST', body: { requisitionId } }),
  learning: () => req('/candidate/learning'),
  startLearning: body => req('/candidate/learning/progress', { method: 'POST', body }),
  accessLog: () => req('/candidate/access-log'),

  /* --- recruiter --- */
  requisitions: () => req('/recruiter/requisitions'),
  requisition: id => req(`/recruiter/requisitions/${id}`),
  createRequisition: body => req('/recruiter/requisitions', { method: 'POST', body }),
  updateRequisition: (id, body) => req(`/recruiter/requisitions/${id}`, { method: 'PATCH', body }),
  analyseJd: body => req('/recruiter/jd/analyse', { method: 'POST', body }),
  searchCandidates: ({ q = '', requisitionId = '' } = {}) =>
    req(`/recruiter/candidates?q=${encodeURIComponent(q)}&requisitionId=${encodeURIComponent(requisitionId)}`),
  candidateDetail: id => req(`/recruiter/candidates/${id}`),
  recruiterApplications: () => req('/recruiter/applications'),
  requisitionQuestions: id => req(`/recruiter/requisitions/${id}/questions`),
  addRequisitionQuestion: (id, body) => req(`/recruiter/requisitions/${id}/questions`, { method: 'POST', body }),
  deleteRequisitionQuestion: (id, qid) => req(`/recruiter/requisitions/${id}/questions/${qid}`, { method: 'DELETE' }),
  setAssessmentMode: (id, mode) => req(`/recruiter/requisitions/${id}/assessment-mode`, { method: 'PUT', body: { mode } }),
  requireAssessment: id => req(`/recruiter/applications/${id}/require-assessment`, { method: 'POST' }),

  /* --- orchestration --- */
  orchestrate: body => req('/orchestrate', { method: 'POST', body }),
  run: id => req(`/runs/${id}`),
  runBrief: id => req(`/runs/${id}/brief`),
  decide: (id, body) => req(`/runs/${id}/decision`, { method: 'POST', body }),
  reassess: (id, body) => req(`/runs/${id}/reassess`, { method: 'POST', body }),
  runs: () => req('/runs'),

  /* --- assessment --- */
  policy: () => req('/assessment/policy'),
  assessmentLanguages: () => req('/assessment/languages'),
  blueprint: body => req('/assessment/blueprint', { method: 'POST', body }),
  startAssessment: body => req('/assessment/start', { method: 'POST', body }),

  /* Identity. The descriptor travels in a POST body and nowhere else — never a
     query string, never storage. The server keeps the template and makes the
     decision; nothing here ever receives it back. */
  identity: () => req('/candidate/identity'),
  registerIdentity: body => req('/candidate/identity/register', { method: 'POST', body }),
  verifyIdentity: body => req('/assessment/identity/verify', { method: 'POST', body }),
  attempt: id => req(`/assessment/${id}`),
  answer: (id, body) => req(`/assessment/${id}/answer`, { method: 'POST', body }),
  proctor: (id, type, simulated = false) =>
    req(`/assessment/${id}/proctor`, { method: 'POST', body: { type, simulated } }),
  runCode: (id, body) => req(`/assessment/${id}/run`, { method: 'POST', body }),
  assessmentSandbox: () => req('/assessment/sandbox'),
  finishAssessment: id => req(`/assessment/${id}/finish`, { method: 'POST' }),
  abandonAssessment: (id, reason) => req(`/assessment/${id}/abandon`, { method: 'POST', body: { reason } }),

  /* --- admin --- */
  adminOverview: () => req('/admin/overview'),
  adminBias: status => req(`/admin/bias${status ? `?status=${status}` : ''}`),
  adminBiasAction: (id, body) => req(`/admin/bias/${id}/action`, { method: 'POST', body }),
  adminAttempts: () => req('/admin/attempts'),
  adminAttemptAction: (id, body) => req(`/admin/attempts/${id}/action`, { method: 'POST', body }),
  adminProctoring: attemptId => req(`/admin/proctoring${attemptId ? `?attemptId=${attemptId}` : ''}`),
  adminDecisions: () => req('/admin/decisions'),
  adminAudit: action => req(`/admin/audit${action ? `?action=${action}` : ''}`),
  adminPeople: () => req('/admin/people'),

  /* --- shared --- */
  audit: () => req('/audit'),
  reset: () => req('/demo/reset', { method: 'POST' }),
};
