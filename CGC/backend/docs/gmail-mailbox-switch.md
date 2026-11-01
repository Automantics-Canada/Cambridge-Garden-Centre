# Gmail invoice inbox — switching to cgcsoftware1718@gmail.com

The code is ready. **Nothing in this runbook has been done against a real
environment.** Every step below is a Google, Microsoft 365 or Railway setting
that a person makes, checks and records.

Items marked **(unconfirmed)** come from vendor documentation or common
behaviour we have not seen on CGC's own systems. Check them on the day.

## How invoices reach the app

1. A supplier emails `ap@cambridgegardencentre.ca` (Microsoft 365).
2. M365 forwards a copy to `cgcsoftware1718@gmail.com` and keeps the original.
3. A Gmail filter puts the invoice label (e.g. `cgc-invoices`) on that copy.
4. Every minute the poller (`src/services/gmail.service.ts`) reads labelled
   mail with attachments that is not yet labelled processed. It works out the
   original sender (`src/services/emailSender.ts`), checks it against
   `GMAIL_SENDER_ALLOWLIST`, turns each PDF/image into a `PENDING_REVIEW`
   invoice, then adds the processed label and marks the email read.

A message is done when it has the processed label, not when it is read, so
someone opening it in Gmail no longer hides it from the poller. Mail from a
sender who is not on the allowlist is left as it is for a person to look at.

## 0. Before you start

- Open `GET /api/health` and read the `gmail` block (fields at the end of this
  page). `reported: false` means no poller has run this version yet.
  `mailbox` shows the polled account masked (`cg…@gmail.com`).
- Look in `cgcsoftware1718@gmail.com` for mail already forwarded (A10 says the
  forward is set up). That backlog includes paid invoices, statements and
  samples. **It must never be labelled**: see step 4 and `GMAIL_POLL_AFTER`.

## 1. Google Cloud project (the one that owns the OAuth client)

- **OAuth consent screen → Publishing status: In production.** In *Testing*,
  refresh tokens for an External app expire after 7 days and the poller stops
  a week after go-live (Google's OAuth "refresh token expiration" notes;
  **(unconfirmed)** that it applies to this project's user type, so publish it
  regardless). An "unverified app" warning on sign-in is expected for a
  single-account app and can be clicked through.
- **Credentials → the OAuth client (Web application) → Authorised redirect
  URIs** must include `https://developers.google.com/oauthplayground`. The
  code issues and refreshes tokens against exactly that URI
  (`OAUTH_REDIRECT_URI` in `gmail.service.ts`).
- The Gmail API must be enabled for the project.

You may use the existing OAuth client (then leave `GMAIL_INBOX_CLIENT_ID` and
`GMAIL_INBOX_CLIENT_SECRET` unset) or a new one (then set both).

## 2. A refresh token for cgcsoftware1718@gmail.com

Do this on a call with whoever controls the account. **Nobody sends us the
Gmail password.**

1. Open <https://developers.google.com/oauthplayground>.
2. Gear icon → tick **Use your own OAuth credentials** → paste the client ID
   and secret. Leave *Access type: Offline*; set *Force prompt: Consent
   Screen* so a refresh token is returned **(unconfirmed: option names as of
   writing)**.
3. In *Input your own scopes* enter
   `https://www.googleapis.com/auth/gmail.modify` → **Authorize APIs**.
   That one scope covers reading mail and attachments, creating and applying
   labels, marking read and reading the profile. The inbox never sends mail.
4. The account owner signs in as `cgcsoftware1718@gmail.com` and clicks Allow.
5. **Exchange authorization code for tokens** → copy the *refresh token*
   straight into Railway (step 3). Never paste it into chat, email or a file.
6. Remove the Playground's access afterwards if you used your own browser
   session; the token keeps working.

Changing the Gmail account's password revokes refresh tokens that carry Gmail
scopes. After a password change, repeat this step.

## 3. Railway variables — on BOTH the API and the worker service

The API runs the pollers itself unless `WORKER_MODE=off`, and the worker
always does (`src/workers/runtime.ts`). If the two services differ, they poll
different mailboxes or with different rules. Set the same values on both,
then redeploy both.

| Variable | Value |
| --- | --- |
| `GMAIL_INBOX_REFRESH_TOKEN` | the token from step 2 |
| `GMAIL_INBOX_CLIENT_ID`, `GMAIL_INBOX_CLIENT_SECRET` | only if you used a different OAuth client |
| `GMAIL_INBOX_USER` | `cgcsoftware1718@gmail.com` — polling stops if the token is for any other mailbox |
| `GMAIL_INVOICE_LABEL` | the label the filter applies, e.g. `cgc-invoices` |
| `GMAIL_TRUSTED_FORWARDERS` | `ap@cambridgegardencentre.ca` |
| `GMAIL_POLL_AFTER` | go-live date, `YYYY-MM-DD` |
| `GMAIL_INGEST_MODE` | `observe` first, `ingest` later |
| `GMAIL_SENDER_ALLOWLIST` | supplier domains/addresses; required for `ingest` only |
| `GMAIL_PROCESSED_LABEL`, `GMAIL_OBSERVED_LABEL` | optional; default `cgc-processed`, `cgc-observed` |

**Do not change** `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
`GMAIL_REFRESH_TOKEN`, `GMAIL_USER` or `GMAIL_PASS`. They send driver email,
including the welcome email; the inbox variables fall back to them only when
unset.

A mistyped `GMAIL_INGEST_MODE` or `GMAIL_POLL_AFTER` stops polling and the
health block says why. It never falls back to ingesting.

## 4. Gmail filter in cgcsoftware1718@gmail.com

Settings → *See all settings* → *Filters and Blocked Addresses* → *Create a
new filter*:

- **Has the words** (leave *From* and *To* empty):
  `from:(ap@cambridgegardencentre.ca) OR to:(ap@cambridgegardencentre.ca)`
  (`from:` catches an Outlook *Forward*, `to:` a *Redirect* or mailbox
  forwarding).
- **Has attachment**: ticked.
- Actions: **Apply the label** `cgc-invoices`, **Never send it to Spam**.
  Forwarded copies often fail DMARC at Gmail and Gmail's API skips Spam.
- **Do NOT tick "Also apply filter to matching conversations".** That labels
  the whole backlog, and the poller would read paid invoices as new.

The poller creates `cgc-processed` / `cgc-observed` itself the first time it
needs them. Do not add them by hand except to deliberately skip a message.

## 5. Prove the M365 forward end to end

1. From an outside address (a personal mailbox), send an email with a made-up
   PDF to `ap@cambridgegardencentre.ca`. Note the time.
2. If that sender gets a bounce with **`550 5.7.520`** ("Your organization does
   not allow external forwarding"), M365 blocked the forward. Their M365 admin
   allows it for the AP mailbox only: Microsoft Defender portal → *Email &
   collaboration* → *Policies & rules* → *Threat policies* → *Anti-spam* →
   create a custom **outbound** spam filter policy, scoped to
   `ap@cambridgegardencentre.ca`, with *Automatic forwarding rules* set to
   **On – Forwarding is enabled**. The admin should also check that no mail
   flow (transport) rule or remote-domain setting blocks auto-forwarding.
   Nothing on our side can see a blocked forward.
3. In Gmail, open the copy → ⋮ → **Show original**:
   - `From:` is the test sender → mailbox forwarding or a *Redirect* rule. The
     health/census shows `mode=redirect`.
   - `From:` is `ap@cambridgegardencentre.ca` with a "FW:" subject → an Outlook
     *Forward* rule. The poller reads the original sender from the quoted
     `From:` line. Check the top `Authentication-Results: mx.google.com; …`
     shows `spf=pass`, `dkim=pass` or `dmarc=pass` for cambridgegardencentre.ca.
     If none passes, every forward is treated as unknown (fail closed): fix the
     domain's SPF/DKIM, or change the rule to *Redirect*.
   - Outlook in another language writes `De:`/`Von:`; that is not recognised
     and reads as unknown. *Forward as attachment* is not supported either.
4. Ask the client to keep *keep a copy* on, so AP still sees every email.

## 6. Go-live

1. Deploy this version to both services. Until `GMAIL_POLL_AFTER` is set the
   query still includes `is:unread`, exactly as before, so deploying cannot
   reach mail somebody already read.
2. Set the step 3 variables with `GMAIL_INGEST_MODE=observe` and
   `GMAIL_POLL_AFTER` = today. Redeploy both.
3. Check `/api/health` → `gmail`: `enabled: true`, `mode: "observe"`,
   `mailboxMatchesConfig: true`, `invoiceLabelFound: true`,
   `lastResult: "ok"`, `stale: false`.
4. **Observe for 1–2 weeks.** Each email becomes one `EmailIngestionEvent` row
   (sender, subject, To, and a census note in `errorMessage` with the mode,
   forwarder, whether the sender is allowlisted and the attachment names and
   types). No invoice is created and the email stays unread. A read-only
   census, run under the production access rules in `AGENTS.md`:

   ```sql
   SELECT "fromAddress", count(*) AS emails, min("receivedAt") AS first_seen, max("receivedAt") AS last_seen
   FROM "EmailIngestionEvent"
   WHERE "errorMessage" LIKE 'observe;%'
   GROUP BY "fromAddress"
   ORDER BY emails DESC;
   ```

   Rows whose note says `mode=unknown` are forwards whose sender could not be
   found; look at one with *Show original*. The census only sees mail that
   reaches the label, so also ask the client which suppliers bill by portal or
   post.
5. Map the senders to suppliers with the client and set
   `GMAIL_SENDER_ALLOWLIST`.
6. Switch to `GMAIL_INGEST_MODE=ingest`. Observed emails are not marked
   processed, so ingest reads them unless the cutoff excludes them: keep
   `GMAIL_POLL_AFTER` at the observe start to ingest the census period, or move
   it to today to skip it. Redeploy both.
7. Verify: one test email forwarded through ap@ produces exactly one
   `PENDING_REVIEW` invoice whose `emailFrom` is the original sender, not ap@
   (check the stored row, not only the logs). Open a second test email in
   Gmail before the next poll; it must still be ingested.

`GMAIL_POLL_AFTER` becomes Gmail's `after:YYYY/MM/DD`. Gmail reads that date
in its own time zone **(unconfirmed: believed to be Pacific)**, so mail in the
first hours of the date in Ontario may fall outside it. Use the day before if
that matters; ingest is idempotent.

**Rollback:** `GMAIL_INGEST_MODE=observe` stops creating invoices. Removing
`GMAIL_INVOICE_LABEL` stops polling. Removing the `GMAIL_INBOX_*` values goes
back to the previous mailbox credentials.

## Health fields (`GET /api/health` → `gmail`)

| Field | Meaning |
| --- | --- |
| `reported`, `stale` | a poller has written a status; the last poll is older than 3 minutes |
| `enabled`, `disabledReason` | whether the last poll ran, and why not |
| `mode` | `ingest` or `observe` (null when the setting is invalid) |
| `invoiceLabel`, `invoiceLabelFound` | the label, and whether it exists in the mailbox |
| `processedLabel`, `observedLabel`, `pollAfter`, `unreadOnly` | tracking labels and cutoff; `unreadOnly` while no cutoff is set |
| `mailbox`, `mailboxMatchesConfig` | polled account (masked), and whether it is `GMAIL_INBOX_USER` |
| `trustedForwarders`, `allowlistEntries` | how many are configured (not the values) |
| `lastPollAt`, `lastResult`, `lastError`, `lastSuccessAt` | last poll; errors are shortened with addresses masked |
| `counts` | last poll: `listed`, `processed`, `invoicesCreated`, `observed`, `duplicates`, `legacySkipped`, `rejectedSender`, `unresolvedSender`, `noAttachments`, `failed` |
| `truncated` | more mail matched than one poll reads (100); the rest waits a minute |

No secret, token or full email address is ever written to the status.

## Upgrade notes

- Invoices were keyed `messageId:attachmentId`; they are now
  `messageId:partId` (or a content hash when Gmail gives no part id). An email
  that already has an invoice under the old key is never ingested again; it is
  just labelled processed (`legacySkipped`). An email the old poller had only
  partly ingested is not completed: upload any missing attachment by hand.
- A rejected email is not fetched again until the next deploy (the allowlist
  only changes with one).

## For the client: exporting the ap@ Safe Senders list

You do not need this: the census in step 6 gives a better list. If you still
want it, either of these works; we treat the result as a starting point, not
the final allowlist.

**Classic Outlook for Windows:** *Home* → *Junk* → *Junk E-mail Options* →
*Safe Senders* tab → **Export to File** → save the `.txt` and send it to us.
Your Contacts are not included even if "Also trust e-mail from my Contacts" is
ticked.

**New Outlook / Outlook on the web:** *Settings* → *Mail* → *Junk email* shows
the list. We do not know of an export button there **(unconfirmed)**; copy it
by hand or use classic Outlook.

**Your M365 admin, in PowerShell** (needs an Exchange admin account; the exact
minimum role is **(unconfirmed)**):

```powershell
Install-Module ExchangeOnlineManagement
Connect-ExchangeOnline -UserPrincipalName <admin address>
Get-MailboxJunkEmailConfiguration -Identity ap@cambridgegardencentre.ca |
  Select-Object -ExpandProperty TrustedSendersAndDomains |
  Out-File ap-safe-senders.txt
```

`TrustedSendersAndDomains` is the Safe Senders list.

## Still open

- Which forward type the client configured (step 5 answers it).
- Whether the M365 forward of a *Forward* rule passes SPF/DKIM/DMARC at Gmail
  (step 5).
- Whether `X-MS-Exchange-Inbox-Rules-Loop` survives to Gmail **(unconfirmed)**;
  redirects are also recognised by `Resent-*`, an SRS `Return-Path` or the
  original `To:`.
- Who controls `cgcsoftware1718@gmail.com` (2-Step Verification, recovery).
- Known senders from supplier records and a review queue for unknown senders
  come in a later change; until then the allowlist is this env variable.
