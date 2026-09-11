# Gmail evidence — the Google Cloud half

Everything on PIE's side is built. This is the part only you can do, because it
needs an account in your name. Budget **about an hour**, and do it before the
night of the 11th, not the morning of the 12th.

---

## Why this is not like GitHub

GitHub connects through Corsair's own OAuth app — `authType: 'managed'` — so
there was nothing to register. **The Gmail plugin has no managed option.** Every
deployment that reads Gmail must register its own Google Cloud OAuth client.

And `gmail.readonly` is one of Google's **restricted scopes**. Publishing an app
that uses it requires a security assessment that takes weeks, so:

| | Testing mode (what you will use) | Published |
|---|---|---|
| Who can connect | only accounts you add by hand, up to 100 | anyone |
| Consent screen | shows **"Google hasn't verified this app"** | clean |
| Time to get it | today | weeks |

Testing mode is a legitimate demo configuration. It is not a production one, and
PIE says so on the Integrations screen rather than letting the difference pass
unnoticed. If a judge asks "could a real candidate connect their Gmail?", the
honest answer is *"not until Google verifies the app — today this works for
accounts we have allow-listed."* That answer is much better received than
discovering it live.

---

## What you are agreeing to

Read this once before you start, because you are about to point software at a
real inbox.

### What PIE does

PIE reads **From, Subject and Date** of messages that match its own certificate
filter. It never asks Gmail for the body of a message — the call is made with
`format: 'metadata'`, and `server/test/scout.test.mjs` test 6 fails if anyone
changes that. The search is always AND-ed with PIE's credential filter; a model
can narrow it and cannot widen it (test 4). PIE cannot send, delete, trash or
modify anything, because none of those operations is in its allowlist (test 1)
and the plugin runs inside the SDK's `runReadonly` scope.

### What you are granting — which is more

**Read this part. It is not the same sentence.**

The consent screen will ask you to allow:

- Send email on your behalf
- See and edit your email labels
- Manage drafts and send emails
- Read, compose and send emails from your Gmail account

That is not a mistake and it is not something you can turn off.
`@corsair-dev/gmail` **hard-codes** its OAuth scopes — `gmail.modify`,
`gmail.labels`, `gmail.send`, `gmail.compose`. There is no `gmail.readonly`
among them, and `permissions: { mode: 'readonly' }` does **not** narrow them:
that option governs which SDK operations are allowed to run, not what Google
asks you to grant.

So both of these are true, and they are different claims:

| | |
|---|---|
| PIE cannot send mail on your behalf | enforced by an allowlist and a readonly scope, with tests |
| The **token** can | it was granted `gmail.send` |

Use an account you are willing to grant that on. Revoke it afterwards at
<https://myaccount.google.com/permissions>. Do not add a friend as a test user
without showing them this section first.

---

## Steps

### 1. Create the project

<https://console.cloud.google.com/projectcreate>

Name it something you will recognise later — `pie-hackbuild` is fine. Wait for it
to finish creating and make sure it is the selected project in the top bar.

### 2. Enable the Gmail API

APIs & Services → Library → search **Gmail API** → **Enable**.

Skipping this is the most common mistake. It fails much later, during the
connect, with an error that mentions nothing about the API being off.

### 3. Configure the OAuth consent screen

APIs & Services → OAuth consent screen.

- User type: **External**
- App name: `PIE — Potential Intelligence Engine`
- User support email and developer contact: your own address
- **Publishing status: leave it on Testing.** Do not press "Publish app".

On the **Scopes** step, add:

```
https://www.googleapis.com/auth/gmail.readonly
```

Google will mark it as a restricted scope and warn you. That is expected.

Note that the connect will **not** actually request this scope — Corsair's plugin
asks for `gmail.modify`, `gmail.labels`, `gmail.send` and `gmail.compose`
instead, and you cannot change that. Listing `gmail.readonly` here is still
right: it is what PIE's own use amounts to, and it is what a reviewer should see
declared. See "What you are granting" above.

On the **Test users** step, add the Gmail address you will demo with. This is
the step people forget; without it the connect fails with `access_denied` and
nothing explains why.

### 4. Create the OAuth client

APIs & Services → Credentials → **Create credentials** → **OAuth client ID**.

- Application type: **Web application**
- Name: `PIE server`
- **Authorised redirect URIs**: paste exactly this, and nothing else:

  ```
  https://auth.corsair.dev/oauth/callback
  ```

  This is the URI *Corsair* redirects to, not PIE's own. Google sends the
  candidate back to Corsair, Corsair exchanges the code and stores the token,
  and PIE never touches it.

  The number is not a guess. Corsair's SDK builds the callback as
  `${apiUrl}/oauth/callback`, and `apiUrl` defaults to `https://auth.corsair.dev`
  — PIE does not override either, so that is the string Google will be asked to
  redirect to. An earlier version of this page told you to copy it from the
  Corsair dashboard, which does not work: the dashboard only shows a Gmail
  plugin once PIE has registered one, and PIE only registers one once these
  credentials exist. That is a circle with no way in.

  Getting this wrong gives you `redirect_uri_mismatch` on the consent screen. It
  is a string comparison — a trailing slash is a mismatch.

You will be shown a **client ID** and a **client secret**. Copy them with the
copy button.

### 5. Put them in `server/.env`

```
GMAIL_CLIENT_ID=<the client ID>
GMAIL_CLIENT_SECRET=<the client secret>
GMAIL_REDIRECT_URL=<the exact redirect URI you registered in step 4>
```

**Leave `GMAIL_REDIRECT_URL` out.** Omitted, Corsair uses the default — which is
the string you registered in step 4. Setting it buys nothing and gives you a
second place for the two to disagree.

### 6. Prove it

```bat
cd F:\PIE_V3\server
node tools\corsair-test.mjs
```

Gmail should now appear in the plugin list. Then, in PIE:

Sign in as a candidate → **Evidence** → **Import** → **Evidence Scout** tab →
**Connect Gmail**.

The consent screen opens in a new tab. You will see the unverified-app warning:
**Advanced** → **Go to PIE (unsafe)** → grant. Come back to PIE and run the
Scout.

---

## When it goes wrong

| What you see | What it actually is |
|---|---|
| `access_denied` | Your address is not in **Test users** (step 3). |
| `redirect_uri_mismatch` | The URI in step 4 ≠ the one Corsair uses. Copy it again. |
| `Gmail API has not been used in project…` | Step 2 was skipped. |
| Consent screen warns the app is unverified | Expected in Testing mode. Advanced → continue. |
| PIE shows Gmail as `not_connected` after you granted | The grant landed on a different Google account than the one you are demoing with. |
| `invalid_client` | Client ID or secret was retyped rather than copied. |

---

## What to say on stage

Do not oversell this. The strong claim is the narrow one, and it is true:

> A candidate who completed a course but lost the certificate still has the
> completion email. PIE reads the sender, subject and date of mail matching its
> credential filter — never the body, and it cannot send, delete or modify
> anything. That restriction is enforced by an allowlist and a read-only policy,
> and there are tests that fail if either is removed.

**If a judge opens the consent screen, they will see `gmail.send` on it.** Say
this before they ask, not after:

> Corsair's Gmail plugin has fixed scopes and no read-only option, so the grant
> is broader than what we use. We show that on the connect screen rather than
> hiding it. PIE's own restriction is enforced in software — but the honest
> statement is "PIE will not", not "nothing can".

That answer is worth more than the feature. A team that found the gap in its own
integration and said so is doing the thing the Bias Audit and human-in-the-loop
parts of PIE are supposed to be about.

If asked about production: the app is in Google's Testing mode, so it reaches
allow-listed accounts only. Publishing needs Google's security assessment for
restricted scopes. Say that plainly — it is a normal state for a two-day build,
and claiming otherwise is the kind of thing a technical judge checks.
