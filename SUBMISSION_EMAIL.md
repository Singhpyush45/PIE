# Hack & Build 2026 — submission email

Send to: **tech4hack.community@gmail.com**

Fill in the three bracketed fields from Snehal before sending. Everything else
is ready.

---

**Subject:**

```
Hack & Build 2026 Submission — Vision Nexus — PIE (Potential Intelligence Engine)
```

**Body:**

```
Hello,

Submitting our project for Hack & Build 2026.

Team Name:           Vision Nexus
Team Leader Name:    [Snehal Vats]
Team Leader Email:   [ ]
Team Leader Phone:   [ ]

Repository:          https://github.com/Singhpyush45/PIE
Live prototype:      https://pie-w5w3.onrender.com

PIE — Potential Intelligence Engine

PIE is a skills-first hiring platform built on one idea: potential over
pedigree. It gathers evidence a candidate has actually produced — repositories,
projects, certificates, assessments — and turns it into skill signals a
recruiter can audit, rather than a score they have to trust. AI recommends;
recruiters decide.

We used Corsair for three of the four use cases in the brief:

1. Dashboards — Corsair syncs each candidate's GitHub into our own Postgres,
   and PIE enriches those rows with what GitHub does not state directly, such
   as whether a repository runs CI.

2. AI Agents — an Evidence Scout decides what evidence to go and get. The
   Corsair plugins expose 78 operations; the agent is offered 10, all reads,
   with bounded arguments. It chooses what to look at and cannot change any
   score: everything it finds enters the same deterministic pipeline as a
   manually-added project, and the scoring engine never sees the model.

3. Knowledge Bases — questions in plain English answered only from the synced
   rows. A model reads the question into filters from a closed vocabulary; PIE
   does the matching itself. Every answer says which rows were searched and why
   each one matched, and reports plainly when a question asks about something
   PIE has not synced, rather than answering no.

We deliberately did not enable Corsair's workflow execution. It runs remote
code in the application process, and PIE handles candidate evidence — so it is
switched off and the server says so at boot.

Gmail is implemented as a narrow evidence source for course-completion mail
(sender, subject and date only, never the message body), but it needs Corsair's
local tunnel to complete the connect flow and we could not get that working on
our machine in time. The code, its tests and its setup notes are in the repo.

Reads are read-only, enforced twice — plugin policy and an enclosing readonly
scope — and a test attempts a real write to prove it is refused.

Thank you,
Rahul Pratap Singh
Vision Nexus — Galgotias University
```

---

## Before you send

- [ ] Snehal's email and phone filled in
- [ ] https://pie-w5w3.onrender.com opens, and a new account can be created
- [ ] `git push` done, and the GitHub link opens for a logged-out visitor
- [ ] Send from an address you will actually check tomorrow

## What the live link does and does not do

Accounts, sign-in and GitHub connect all work there. **Corsair is deliberately
not configured on that host** — it shares one Corsair development key with the
laptop, and two apps registering the same delivery URL overwrite each other. So
the Evidence Scout on the live site says "Corsair is not configured here",
which is true and is what PIE is supposed to say.

The Corsair demo runs locally, where the integration is configured and proven.
If a judge clicks the live link, they get a working product with one integration
switched off and labelled as such — not a broken page.
