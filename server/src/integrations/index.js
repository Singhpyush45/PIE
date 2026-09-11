// Landscape view across every external integration PIE can use.
//
// The Integrations screen renders exactly what these adapters report and nothing
// more. An adapter says CONNECTED only after a real call has succeeded — having
// the environment variables set is never enough. That rule is the whole point of
// this file, and it is worth more than any particular integration behind it.

import * as corsair from './corsair.js';
import * as github from './githubEvidenceAdapter.js';

export const adapters = { corsair, github };

export function landscape() {
  return {
    generatedAt: new Date().toISOString(),
    principle: 'PIE never claims a live integration unless credentials, endpoints and actual '
      + 'connectivity exist. Every state below is read from its adapter at request time.',
    services: [corsair.status(), github.status()],
  };
}
