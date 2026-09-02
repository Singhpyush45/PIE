// SAP Learning Hub, student edition adapter.
//
// HONESTY BOUNDARY: SAP does not expose a public enrolment or completion API for the
// student edition that this team has been able to verify. This adapter therefore
// implements LINK REDIRECTION only. It never asserts enrolment or completion.

import { LEARNING_RESOURCES, LEARNING_PROVIDERS } from '../data.js';

export const STUDENT_EDITION_URL = 'https://learning.sap.com/free-student-edition';

export function isConfigured() { return true; }   // link redirection needs no credentials

export function status() {
  return {
    key: 'sap_learning_hub',
    name: 'SAP Learning Hub, student edition',
    state: 'LINK_REDIRECTION_ACTIVE',
    detail: 'PIE maps skill gaps to SAP-provided learning objectives and hands the candidate off to learning.sap.com. PIE does not own the candidate’s SAP Universal ID.',
    classification: 'CONFIRMED — link/resource redirection',
    limitation: 'No verified enrolment or completion API. Completion is never asserted by PIE; it is either candidate-declared evidence or verified by PIE reassessment.',
    requires: 'Candidate registers with their own SAP Universal ID',
  };
}

/** Resources PIE can route a candidate to for a given canonical skill id. */
export function getLearningResources(skillId) {
  return LEARNING_RESOURCES
    .filter(r => !skillId || r.skill === skillId)
    .map(r => ({
      ...r,
      providerName: LEARNING_PROVIDERS[r.provider].name,
      providerSource: LEARNING_PROVIDERS[r.provider].source,
      verification_status: LEARNING_PROVIDERS[r.provider].verification_status,
      completion_verification: LEARNING_PROVIDERS[r.provider].completion_verification,
    }));
}

export function fetchCourses() { return getLearningResources(null); }

/** Completion can never be claimed from the Hub — this is the only truthful answer. */
export function verifyCompletion() {
  return {
    verified: false,
    reason: 'External learning resource — completion verification requires supported SAP integration or candidate-provided evidence.',
  };
}
