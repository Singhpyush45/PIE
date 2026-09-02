// Landscape view across every SAP adapter. The SAP Integration Readiness screen
// renders exactly what these adapters report — it cannot overstate them.
import * as genai from './sapGenAiHub.js';
import * as learning from './sapLearningHub.js';
import * as btp from './sapBtpCap.js';
import * as hana from './sapHanaRepository.js';
import * as sf from './successFactors.js';
import * as sac from './sapAnalytics.js';

export const adapters = { genai, learning, btp, hana, sf, sac };

export function landscape() {
  return {
    generatedAt: new Date().toISOString(),
    principle: 'PIE never claims a live SAP integration unless credentials, endpoints and actual connectivity exist. Every state below is read from the adapter at request time.',
    services: [genai, learning, btp, hana, sf, sac].map(a => a.status()),
  };
}
