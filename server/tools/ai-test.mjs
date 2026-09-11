// Makes one real call to the configured LLM and says exactly what came back.
//
//   node tools\ai-test.mjs
//
// WHY THIS EXISTS
//   PIE is built to work without a model: every score is deterministic, and each
//   agent falls back to template narration when the provider is unavailable.
//   That is the right behaviour, and it has one cost — a provider that is
//   failing every single call looks, from the outside, exactly like a provider
//   that is merely absent. The product keeps working and nobody finds out.
//
//   The Evidence Scout made that visible for the first time, because it is the
//   one component whose whole point is the model's decisions: when it reported
//   "the model stopped returning usable decisions", that was not a Scout bug.
//   It was PIE saying out loud what the other agents had been absorbing quietly.
//
//   So this makes one call, with no fallback, and prints the provider's own
//   words. It never prints the API key.
//
// THE USUAL CAUSE
//   OpenAI's newer models rejected the older request shape: `max_tokens` became
//   `max_completion_tokens`, and some of them accept only the default
//   temperature. A request with the old field returns 400 with a message that
//   names the field — which this tool shows you verbatim.

import '../src/env.js';
import { providerStatus, providerChain, complete, completeJson } from '../src/ai/provider.js';

const line = (label, value) => console.log(`  ${String(label).padEnd(22)} ${value}`);

console.log('\nAI provider — one real call\n');

/* ------------------------------------------------------------- what is set */

const st = providerStatus();
line('provider', st.provider);
line('mode', st.mode);
line('model', st.model || '(provider default)');
line('enabled', st.enabled ? 'yes' : 'no');

// The order matters more than the winner. Two keys where the first is out of
// credit is the case this tool exists for.
const chain = providerChain();
line('order PIE will try', chain.map(p => p.name).join(' → ') || '(none)');
if (chain.length > 1) {
  console.log('  (a provider that errors is stepped past — the next key is tried automatically)');
}
if (!process.env.AI_PROVIDER && chain.length > 1) {
  console.log(`  Set AI_PROVIDER=${chain[1].key} in .env to put ${chain[1].name} first instead.`);
}

if (!st.enabled) {
  console.log('\n  No provider is configured. PIE runs its deterministic engine and template');
  console.log('  narration — every score is identical. Set OPENAI_API_KEY, GEMINI_API_KEY');
  console.log('  or OLLAMA_BASE_URL to enable the narration layer.\n');
  process.exit(0);
}

/* ------------------------------------------------------------ a plain call */

console.log('\nPlain completion');
const plain = await complete(
  [{ role: 'user', content: 'Reply with the single word: ready' }],
  { maxTokens: 20, temperature: 0 },
);

if (plain.ok) {
  line('result', 'OK');
  line('answered by', plain.provider);
  if (plain.failedOver) {
    line('failed over', `past ${(plain.skipped || []).join(', ')}`);
    console.log('\n  PIE stepped past a provider that errored and used the next configured key.');
    console.log('  Nothing is broken — but the skipped one is worth fixing or removing.\n');
  }
  line('replied', JSON.stringify(String(plain.text || '').slice(0, 60)));
} else {
  line('result', 'FAILED');
  if (plain.triedProviders?.length > 1) line('tried', plain.triedProviders.join(', '));
  console.log(`\n  Every configured provider was asked. They said:\n    ${plain.error}\n`);

  const e = String(plain.error || '');
  const hint =
    /max_tokens.*not supported|max_completion_tokens/i.test(e)
      ? 'This model wants `max_completion_tokens` instead of `max_tokens`. Either set\n'
        + '  OPENAI_MODEL to a model that accepts the older shape (gpt-4o-mini, gpt-4o),\n'
        + '  or update callRaw() in src/ai/provider.js to send the new field.'
    : /temperature.*does not support|unsupported value.*temperature/i.test(e)
      ? 'This model accepts only its default temperature. Set OPENAI_MODEL to gpt-4o-mini,\n'
        + '  or stop sending a temperature for this model.'
    : /model.*does not exist|invalid model|unknown model/i.test(e)
      ? 'OPENAI_MODEL names a model this key cannot reach. Check the spelling, or unset it\n'
        + '  to use the default.'
    : /401|invalid_api_key|incorrect api key/i.test(e)
      ? 'The key was rejected. It may be revoked, from a different account, or truncated\n'
        + '  when it was pasted.'
    : /429|quota|billing/i.test(e)
      ? 'Rate limited or out of quota. Check the billing page for this key.'
    : /ENOTFOUND|ETIMEDOUT|fetch failed/i.test(e)
      ? 'The provider could not be reached. Check the network, and OPENAI_BASE_URL if you set one.'
      : 'Read the message above — it is the provider\'s own, unedited.';

  console.log(`  Most likely:\n  ${hint}\n`);
  console.log('  PIE keeps working either way: scores are deterministic and the agents fall');
  console.log('  back to template narration. What you lose is the Evidence Scout choosing');
  console.log('  what to investigate, and the written explanations being model-written.\n');
  process.exit(1);
}

/* ------------------------------------------------------------- a JSON call */
// The Scout does not need prose. It needs a decision it can act on, and that is
// a different capability: a model can answer well and still not honour
// response_format.

console.log('\nJSON completion — what the Evidence Scout actually needs');
const shaped = await completeJson([
  { role: 'system', content: 'Reply with JSON only: {"done": false, "operation": "github.api.users.get", "why": "one short sentence"}' },
  { role: 'user', content: 'Which operation should run first?' },
], { maxTokens: 900, temperature: 0.1 });

if (!shaped.ok || !shaped.data) {
  line('result', 'FAILED');
  console.log(`\n  ${shaped.error || 'the reply was not valid JSON'}\n`);
  if (/after a retry/.test(String(shaped.error || ''))) {
    console.log('  PIE already retried with a larger budget, so this is not truncation.');
    console.log('  The model is answering with something that is not JSON.\n');
  }
  console.log('  Plain completions work but structured ones do not, so the Scout will run its');
  console.log('  fixed plan. The evidence it gathers is real either way; only the choice of');
  console.log('  what to look at stops being adaptive.\n');
  process.exit(1);
}

line('result', 'OK');
line('operation chosen', shaped.data.operation || '(none)');
line('reason given', String(shaped.data.why || '').slice(0, 60));
if (shaped.retriedForLength) {
  line('note', 'the first reply was cut short; PIE retried with more room');
}

console.log('\n  The provider answers, and answers in the shape the Scout needs.');
console.log('  If the Scout still reports DEGRADED, the problem is in the loop rather than');
console.log('  the provider — send the call log.\n');
