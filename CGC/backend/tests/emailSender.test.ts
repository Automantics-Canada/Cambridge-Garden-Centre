import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findForwardedFrom,
  forwarderAuthenticated,
  htmlToText,
  matchesSenderList,
  parseAddress,
  resolveSender,
} from '../src/services/emailSender.js';

/**
 * Who really sent a message that reached the invoice inbox.
 *
 * Every name, domain and address here is invented. The AP mailbox stands in as
 * ap@garden-centre.test and the supplier as billing@stone-supplier.test.
 */

const FORWARDER = 'ap@garden-centre.test';
const SUPPLIER = 'billing@stone-supplier.test';
const options = { trustedForwarders: [FORWARDER] };

/** What Gmail stamps on a message the forwarder's domain really sent. */
const AUTH_PASS =
  'mx.google.com; dkim=pass header.i=@garden-centre.test header.s=selector1 header.b=AbCd; ' +
  'spf=pass (google.com: domain of ap@garden-centre.test designates 192.0.2.10 as permitted sender) ' +
  'smtp.mailfrom=ap@garden-centre.test; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=garden-centre.test';

function headers(entries: Record<string, string | string[]>) {
  return Object.entries(entries).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map(v => ({ name, value: v })));
}

const PLAIN_FORWARD = [
  'Please process, thanks.',
  '',
  '-----Original Message-----',
  'From: Stone Supplier Billing <billing@stone-supplier.test>',
  'Sent: Monday, November 2, 2026 9:14 AM',
  'To: AP <ap@garden-centre.test>',
  'Subject: Invoice 90001',
  '',
  'Invoice attached.',
].join('\r\n');

const OUTLOOK_PLAIN_FORWARD = [
  '',
  '________________________________',
  'From: Stone Supplier Billing [mailto:billing@stone-supplier.test]',
  'Sent: Monday, November 2, 2026 9:14 AM',
  'To: AP',
  'Subject: Invoice 90001',
].join('\n');

const OUTLOOK_HTML_FORWARD =
  '<html><head><style>p{margin:0}</style></head><body><div>FYI</div>' +
  '<hr style="display:inline-block;width:98%" tabindex="-1">' +
  '<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt">' +
  '<b>From:</b> Stone Supplier Billing &lt;billing@stone-supplier.test&gt;<br>' +
  '<b>Sent:</b> Monday, November 2, 2026 9:14 AM<br>' +
  '<b>To:</b> AP &lt;ap@garden-centre.test&gt;<br>' +
  '<b>Subject:</b> Invoice 90001</font><div>&nbsp;</div></div>' +
  '<div>Invoice attached.</div></body></html>';

describe('parseAddress', () => {
  it('reads the address out of the usual From forms', () => {
    assert.equal(parseAddress('Stone Supplier <Billing@Stone-Supplier.test>'), SUPPLIER);
    assert.equal(parseAddress('"Supplier, Billing" <billing@stone-supplier.test>'), SUPPLIER);
    assert.equal(parseAddress('Stone Supplier [mailto:billing@stone-supplier.test]'), SUPPLIER);
    assert.equal(parseAddress(' billing@stone-supplier.test '), SUPPLIER);
  });

  it('takes the real address, not one written into the display name', () => {
    // The sender chooses the display name. A name that looks like a supplier's
    // address must not make the message the supplier's.
    const IMPOSTOR = 'someone@elsewhere.test';
    assert.equal(parseAddress(`"Stone <${SUPPLIER}>" <${IMPOSTOR}>`), IMPOSTOR);
    assert.equal(parseAddress(`"${SUPPLIER}" <${IMPOSTOR}>`), IMPOSTOR);
    assert.equal(parseAddress(`Stone [mailto:${SUPPLIER}] [mailto:${IMPOSTOR}]`), IMPOSTOR);
    assert.equal(parseAddress(`Stone <${SUPPLIER}> [mailto:${IMPOSTOR}]`), IMPOSTOR);
    assert.equal(parseAddress(`Stone [mailto:${SUPPLIER}] <${IMPOSTOR}>`), IMPOSTOR);
  });

  it('returns null when there is no address', () => {
    assert.equal(parseAddress('Stone Supplier Billing'), null);
    assert.equal(parseAddress(''), null);
    assert.equal(parseAddress(undefined), null);
  });
});

describe('matchesSenderList', () => {
  it('matches the full address, the domain or @domain, ignoring case', () => {
    assert.equal(matchesSenderList(SUPPLIER, ['stone-supplier.test']), true);
    assert.equal(matchesSenderList(SUPPLIER, ['@stone-supplier.test']), true);
    assert.equal(matchesSenderList('Billing@Stone-Supplier.test', ['billing@stone-supplier.test']), true);
  });

  it('matches nothing for an empty list, a missing address or a lookalike domain', () => {
    assert.equal(matchesSenderList(SUPPLIER, []), false);
    assert.equal(matchesSenderList(null, ['stone-supplier.test']), false);
    assert.equal(matchesSenderList('billing@not-stone-supplier.test', ['stone-supplier.test']), false);
  });
});

describe('resolveSender: direct', () => {
  it('a supplier writing straight to the inbox is the sender', () => {
    const result = resolveSender(headers({ From: `Stone Supplier <${SUPPLIER}>`, To: 'inbox@example.test' }), 'Hi', options);
    assert.deepEqual(
      { originalSender: result.originalSender, forwardedBy: result.forwardedBy, mode: result.mode },
      { originalSender: SUPPLIER, forwardedBy: null, mode: 'direct' }
    );
  });

  it('no From address at all is unknown', () => {
    const result = resolveSender(headers({ Subject: 'x' }), undefined, options);
    assert.equal(result.mode, 'unknown');
    assert.equal(result.originalSender, null);
  });

  it('accepts a header record as well as the Gmail header list', () => {
    const result = resolveSender({ from: SUPPLIER }, undefined, options);
    assert.equal(result.originalSender, SUPPLIER);
  });
});

describe('resolveSender: redirect (M365 mailbox forwarding or a Redirect rule)', () => {
  it('Resent-From naming the forwarder keeps the supplier as the sender', () => {
    const result = resolveSender(headers({ From: SUPPLIER, 'Resent-From': FORWARDER }), undefined, options);
    assert.equal(result.mode, 'redirect');
    assert.equal(result.originalSender, SUPPLIER);
    assert.equal(result.forwardedBy, FORWARDER);
  });

  it('the Exchange inbox-rules loop header names the forwarder', () => {
    const result = resolveSender(headers({ From: SUPPLIER, 'X-MS-Exchange-Inbox-Rules-Loop': FORWARDER }), undefined, options);
    assert.equal(result.mode, 'redirect');
    assert.equal(result.forwardedBy, FORWARDER);
  });

  it('an SRS envelope sender at the forwarder domain counts', () => {
    const result = resolveSender(
      headers({ From: SUPPLIER, 'Return-Path': '<bounces+SRS=k3j4=AB@garden-centre.test>' }),
      undefined,
      options
    );
    assert.equal(result.mode, 'redirect');
    assert.equal(result.forwardedBy, FORWARDER);
  });

  it('mail addressed to the forwarder arriving here is a redirect', () => {
    const result = resolveSender(headers({ From: SUPPLIER, To: `Accounts Payable <${FORWARDER}>` }), undefined, options);
    assert.equal(result.mode, 'redirect');
    assert.equal(result.originalSender, SUPPLIER);
  });
});

describe('resolveSender: forward (an Outlook "Forward to" rule)', () => {
  const forwardHeaders = headers({ From: `Accounts Payable <${FORWARDER}>`, 'Authentication-Results': AUTH_PASS });

  it('reads the supplier from a plain-text "Original Message" block', () => {
    const result = resolveSender(forwardHeaders, PLAIN_FORWARD, options);
    assert.equal(result.mode, 'forward');
    assert.equal(result.originalSender, SUPPLIER);
    assert.equal(result.forwardedBy, FORWARDER);
  });

  it('reads the supplier after the Outlook underscore rule, in [mailto:] form', () => {
    const result = resolveSender(forwardHeaders, { text: OUTLOOK_PLAIN_FORWARD }, options);
    assert.equal(result.mode, 'forward');
    assert.equal(result.originalSender, SUPPLIER);
  });

  it('reads the supplier from an Outlook HTML body', () => {
    assert.equal(resolveSender(forwardHeaders, { html: OUTLOOK_HTML_FORWARD }, options).originalSender, SUPPLIER);
    // A bare string that is HTML is converted too.
    assert.equal(resolveSender(forwardHeaders, OUTLOOK_HTML_FORWARD, options).originalSender, SUPPLIER);
  });

  it('falls back to the HTML body when the plain text has no block', () => {
    const result = resolveSender(forwardHeaders, { text: 'See attached.', html: OUTLOOK_HTML_FORWARD }, options);
    assert.equal(result.originalSender, SUPPLIER);
  });

  it('uses the first block, not an older reply quoted under it', () => {
    const nested = PLAIN_FORWARD + '\n\n-----Original Message-----\nFrom: someone@older-thread.test\nSent: Friday\nSubject: Re';
    assert.equal(resolveSender(forwardHeaders, nested, options).originalSender, SUPPLIER);
  });
});

describe('resolveSender: fails closed', () => {
  it('mail the forwarder wrote itself has no original sender', () => {
    const result = resolveSender(
      headers({ From: FORWARDER, 'Authentication-Results': AUTH_PASS }),
      'Lunch is at noon. Invoice from last week attached.',
      options
    );
    assert.equal(result.mode, 'unknown');
    assert.equal(result.originalSender, null);
    assert.equal(result.forwardedBy, FORWARDER);
  });

  it('a forged From of the forwarder is not believed', () => {
    // Anybody can write "From: ap@..." and a forwarded block naming a known
    // supplier. Gmail's own check says the forwarder's domain did not send it.
    const forged = 'mx.google.com; dkim=fail header.i=@garden-centre.test; spf=fail smtp.mailfrom=ap@garden-centre.test; ' +
      'dmarc=fail (p=NONE) header.from=garden-centre.test';
    const result = resolveSender(headers({ From: FORWARDER, 'Authentication-Results': forged }), PLAIN_FORWARD, options);
    assert.equal(result.mode, 'unknown');
    assert.equal(result.originalSender, null);
  });

  it('no Authentication-Results, or one not written by Gmail, is not authentication', () => {
    assert.equal(resolveSender(headers({ From: FORWARDER }), PLAIN_FORWARD, options).mode, 'unknown');
    const planted = AUTH_PASS.replace('mx.google.com', 'mail.attacker.test');
    assert.equal(resolveSender(headers({ From: FORWARDER, 'Authentication-Results': planted }), PLAIN_FORWARD, options).mode, 'unknown');
  });

  it('only the topmost Gmail result counts', () => {
    // A pass planted lower in the headers sits under Gmail's own fail.
    const forged = 'mx.google.com; dkim=fail header.i=@garden-centre.test; spf=softfail smtp.mailfrom=ap@garden-centre.test';
    assert.equal(
      forwarderAuthenticated(headers({ 'Authentication-Results': [forged, AUTH_PASS] }), FORWARDER),
      false
    );
  });

  it('a pass for some other domain does not authenticate the forwarder', () => {
    const other = 'mx.google.com; dkim=pass header.i=@elsewhere.test; spf=pass smtp.mailfrom=x@elsewhere.test; dmarc=pass header.from=elsewhere.test';
    assert.equal(forwarderAuthenticated(headers({ 'Authentication-Results': other }), FORWARDER), false);
  });

  it('a "From:" sentence outside a header block is not a sender', () => {
    const prose = '________________________________\nFrom: our yard, two loads went out.\nThanks';
    assert.equal(findForwardedFrom(prose), null);
  });

  it('a block naming a display name only, with no address, is unknown', () => {
    const noAddress = '-----Original Message-----\nFrom: Stone Supplier Billing\nSent: Monday\nSubject: Invoice';
    assert.equal(resolveSender(headers({ From: FORWARDER, 'Authentication-Results': AUTH_PASS }), noAddress, options).mode, 'unknown');
  });

  it('a forwarded block whose display name imitates a supplier names the real sender', () => {
    // Outlook copies the display name into the block as it was sent, so an
    // impostor can make the line read "From: Stone <billing@...> <their own>".
    const impostor = PLAIN_FORWARD.replace(
      'From: Stone Supplier Billing <billing@stone-supplier.test>',
      'From: Stone <billing@stone-supplier.test> <someone@elsewhere.test>'
    );
    const result = resolveSender(headers({ From: FORWARDER, 'Authentication-Results': AUTH_PASS }), impostor, options);
    assert.equal(result.originalSender, 'someone@elsewhere.test');
    const html = OUTLOOK_HTML_FORWARD.replace(
      'Stone Supplier Billing &lt;billing@stone-supplier.test&gt;',
      'Stone [mailto:billing@stone-supplier.test] &lt;someone@elsewhere.test&gt;'
    );
    assert.equal(resolveSender(headers({ From: FORWARDER, 'Authentication-Results': AUTH_PASS }), { html }, options).originalSender, 'someone@elsewhere.test');
  });

  it('a direct sender whose display name imitates a supplier is not that supplier', () => {
    const result = resolveSender(headers({ From: `"Stone <${SUPPLIER}>" <someone@elsewhere.test>` }), undefined, options);
    assert.equal(result.originalSender, 'someone@elsewhere.test');
  });

  it('a block in another language is unknown rather than guessed', () => {
    const french = '________________________________\nDe : Stone Supplier <billing@stone-supplier.test>\nEnvoyé : lundi\nObjet : Facture';
    assert.equal(resolveSender(headers({ From: FORWARDER, 'Authentication-Results': AUTH_PASS }), french, options).mode, 'unknown');
  });

  it('a forward of something the forwarder itself sent is unknown', () => {
    const selfForward = PLAIN_FORWARD.replace('billing@stone-supplier.test', FORWARDER);
    assert.equal(resolveSender(headers({ From: FORWARDER, 'Authentication-Results': AUTH_PASS }), selfForward, options).mode, 'unknown');
  });

  it('without trusted forwarders, mail from the AP mailbox is just direct mail from it', () => {
    const result = resolveSender(headers({ From: FORWARDER, 'Authentication-Results': AUTH_PASS }), PLAIN_FORWARD, {});
    assert.equal(result.mode, 'direct');
    assert.equal(result.originalSender, FORWARDER);
  });
});

describe('htmlToText', () => {
  it('keeps the line structure and decodes entities after removing tags', () => {
    const text = htmlToText('<p>A&amp;B</p><div>&lt;x@y.test&gt;&#160;&#x41;</div><br>end');
    assert.match(text, /A&B\n/);
    assert.match(text, /<x@y\.test> A/);
    assert.match(text, /\nend$/);
  });
});
