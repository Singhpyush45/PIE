# Hack & Build — run sheet

12 September, Nagarro Gurugram. Entry 9:50, **gate closes 10:20**.

---

## Before you leave

- [ ] Laptop charger. The demo is local; a flat battery is the whole demo.
- [ ] Phone hotspot ready — venue wifi is not a plan.
- [ ] `F:\PIE_V3` opens and `npm start` works, on battery, once.

## On arrival, in this order

```powershell
cd F:\PIE_V3
npm start
```

Root, not `server` — root builds the frontend first.

Watch the boot lines. These four should be there:

```
env: Corsair → ... set
Corsair: SDK active — evidence reads are tenant-scoped and read-only.
Supabase restore: N row(s) recovered
AI: <provider> [LIVE]      ← or nothing; see below
```

Then, signed in as the candidate:

- [ ] Evidence → Import → **Re-sync from GitHub** — badge should read **4 synced**
- [ ] Knowledge Base → all four questions
- [ ] Evidence Scout → Run

**Do this before the room fills up.** The sync is the one step that touches the
network, and it is the one that will be slow on venue wifi.

---

## The five-minute path

1. **Candidate → Evidence.** "This is what PIE has, and where each piece came from."
2. **Re-sync from GitHub.** Corsair pulls the repositories into PIE's own Postgres.
3. **Knowledge Base → "which of these are JavaScript?"** Answer, plus *why* each
   row matched, plus the provenance line: answered from synced rows, no live
   GitHub call.
4. **"anything that runs CI?"** Real answer now — the sync reads GitHub Actions.
   If a repository has none, PIE says so rather than staying silent.
5. **Evidence Scout → Run.** Show **every call it made**. Then the boundary line:
   it decides what to look at, and it cannot change any score.
6. **Recruiter side.** The match, the explanation, and the human decision gate.

The line worth landing: **every number is deterministic.** The model reads
sentences and chooses what to look at. It never produces a score.

---

## "How did you do the Corsair integration?"

Do not open Corsair's dashboard. It is their panel, not your evidence. Open the
terminal and the call log.

**Thirty seconds:**

> Corsair is an npm SDK that runs inside our server — not a REST service. It
> owns four core tables in our own Postgres, plus one for its readonly
> enforcement. Every candidate is a tenant, and their GitHub credential is
> stored encrypted against that tenant. Each plugin gives us two surfaces:
> `db` for synced rows, `api` for the live call. Reading evidence is now a
> local query instead of a fan-out against the GitHub API.

**On where the credentials live** — this is worth saying precisely, because it
is the thing a security-minded judge will probe:

> The tokens never leave our database. Each connection gets its own data
> encryption key; the KEK in our environment encrypts those keys, so
> compromising one connection does not expose the others. Corsair's Hub runs
> the connect and approval flow and relays webhooks — it holds none of the
> tokens.

**On the boundary between Corsair's data and ours** — this is the design
decision, and it matches what Corsair's own documentation recommends:

> `corsair_entities` is Corsair's mirror of what the provider said, and it
> updates that row itself through webhooks and API calls. So anything PIE works
> out — whether a repository runs CI, how long it was worked on — lives in our
> own table and is joined on read. We learned that the hard way: writing our
> fields into Corsair's row dropped them silently, and writing under our own key
> produced a second copy of every repository, because Corsair upserts by the
> provider's resource id and we were passing the full name.

**If they go deeper — four controls, layered on purpose:**

1. **Read-only, enforced twice.** The plugin is built
   `permissions: { mode: 'readonly' }`, and every call runs inside the SDK's
   `runReadonly()` scope. Demonstrated, not claimed:
   `node tools\corsair-test.mjs` attempts a **real** write and prints REFUSED.
   That is what created the `proof_readonly` tenant on the dashboard.
2. **An allowlist on the model's choice set.** The plugins expose 78 operations,
   including `messages.delete` and `repositories.star`. The agent is offered 10,
   all reads. An operation the model is never told about cannot be proposed —
   and cannot be talked into being proposed by text in a repository description.
3. **Bounded arguments.** An allowlisted operation with free arguments is not a
   bounded tool.
4. **Tenant scoping.** PIE cannot read Corsair without a tenant at all; tests 6
   and 7 are exactly that.

**One detail an engineer will like:** `/api/corsair` is mounted **before**
`express.json()`, because Hub signs its deliveries with an HMAC over the exact
wire bytes and a JSON parser destroys them.

**Show these two, in this order:**

1. `node tools\corsair-test.mjs` — CONNECTED, the plugin list, and the write REFUSED
2. The Evidence Scout's **call log**, then the boundary line beneath it

The second one is the strongest thing you have. Most teams say "we built an AI
agent". You are showing every call it made and stating what it cannot do.

---

## Three questions you will be asked, and the true answers

**"Does the Scout need the model?"**
No. With no provider it runs a fixed plan and says so on screen. The evidence is
the same; only the choice of what to investigate stops being adaptive.

**"Gmail asks for send access — why?"**
Corsair's Gmail plugin hard-codes its scopes and offers no read-only one. PIE
only ever lists messages and reads From, Subject and Date, never the body, and
cannot send or modify anything — but the grant is broader than the use, and we
show that on the connect screen rather than hiding it. The honest sentence is
"PIE will not", not "nothing can".

**"Why is Corsair off on the live site?"**
It shares one Corsair development key with this laptop, and two apps registering
the same delivery URL overwrite each other. The live site says "Corsair is not
configured here", which is true. The fix is a separate production key; we did
not do it hours before a demo.

And if asked about workflow automations — the fourth use case in the brief:
Corsair's workflow execution runs remote code in the application process. PIE
handles candidate evidence, so it is deliberately off, and the server says so at
boot.

---

## If something breaks

| | |
|---|---|
| Scout says DEGRADED | Expected if both providers are out of quota. The evidence is real; say so and carry on. `node tools\ai-test.mjs` if you want to show why. |
| Knowledge Base says "0 synced" | Re-sync. If that fails: `node tools\corsair-probe.mjs cand_can_c61dd20c` |
| Corsair shows NOT_CONFIGURED | `node tools\env-doctor.mjs` — it reports duplicates and typos |
| UI changes not showing | You ran `cd server && npm start`, which does not rebuild. Use root `npm start`. |

**Do not fix anything during the demo.** A known, explained limitation lands
better than a repair attempted in front of a judge.
