import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildKnownSenders,
  FREE_MAIL_DOMAINS,
  isFreeMailDomain,
  lookupSender,
  normaliseSenderEntries,
  type SupplierSenderRecord,
} from '../src/services/knownSenders.js';
// The supplier form keeps its own copy of the free-mail list.
import * as frontendSenders from '../../frontend/src/lib/emailSenders.js';

/**
 * Who the invoice inbox recognises, from supplier records and the env list.
 * Every company, address and domain is invented.
 */

const supplier = (over: Partial<SupplierSenderRecord> & { id: string }): SupplierSenderRecord => ({
  name: `Supplier ${over.id}`,
  type: 'SUPPLIER',
  emailDomains: [],
  emailAddresses: [],
  contactEmail: null,
  ...over,
});

describe('free-mail domains', () => {
  it('covers the shared services, every yahoo.* and Canadian ISPs, case-insensitively', () => {
    for (const domain of ['gmail.com', 'Outlook.com', 'hotmail.ca', 'live.com', 'icloud.com', 'yahoo.ca', 'yahoo.co.uk', '@rogers.com']) {
      assert.equal(isFreeMailDomain(domain), true, domain);
    }
    for (const domain of ['stone-supplier.test', 'yahoo-gravel.test', 'gmail.com.example', '']) {
      assert.equal(isFreeMailDomain(domain), false, domain);
    }
  });

  it('the supplier form uses the same list', () => {
    assert.deepEqual([...frontendSenders.FREE_MAIL_DOMAINS].sort(), [...FREE_MAIL_DOMAINS].sort());
    for (const domain of ['yahoo.fr', 'gmail.com', 'stone-supplier.test']) {
      assert.equal(frontendSenders.isFreeMailDomain(domain), isFreeMailDomain(domain), domain);
    }
  });
});

describe('lookupSender', () => {
  const index = buildKnownSenders([
    supplier({ id: 's1', name: 'Example Stone', emailDomains: ['Stone-Supplier.test'] }),
    supplier({ id: 's2', name: 'Example Haulage', type: 'TRUCKING_COMPANY', emailAddresses: ['Dispatch.Owner@gmail.com'] }),
    supplier({ id: 's3', name: 'Example Mulch', contactEmail: 'Sales@Mulch-Yard.test' }),
    // Saved before the form refused it: must not claim every Gmail user.
    supplier({ id: 's4', name: 'Old Record', emailDomains: ['gmail.com', 'person@old-record.test'] }),
    // An exact address listed by one supplier at another's domain.
    supplier({ id: 's5', name: 'Example Pavers', emailAddresses: ['pavers.desk@stone-supplier.test'] }),
    // The same domain on two records.
    supplier({ id: 's6', emailDomains: ['shared-group.test'] }),
    supplier({ id: 's7', emailDomains: ['shared-group.test'] }),
  ]);

  it('a domain matches every address at it, ignoring case', () => {
    const found = lookupSender(index, 'Billing@STONE-supplier.test');
    assert.equal(found.known, true);
    assert.equal(found.supplier?.id, 's1');
    assert.equal(found.matchedBy, 'domain');
  });

  it('an exact address beats the domain it sits in', () => {
    assert.equal(lookupSender(index, 'pavers.desk@stone-supplier.test').supplier?.id, 's5');
  });

  it('a free-mail sender is known by exact address only', () => {
    const owner = lookupSender(index, 'dispatch.owner@gmail.com');
    assert.equal(owner.supplier?.id, 's2');
    assert.equal(owner.supplier?.type, 'TRUCKING_COMPANY');
    assert.equal(owner.matchedBy, 'address');

    const stranger = lookupSender(index, 'someone.else@gmail.com');
    assert.equal(stranger.known, false, 'a gmail.com domain on a supplier must not match');
    assert.equal(stranger.supplier, null);
  });

  it('the contact email is an exact address, and an address saved among the domains still works', () => {
    assert.equal(lookupSender(index, 'sales@mulch-yard.test').supplier?.id, 's3');
    assert.equal(lookupSender(index, 'other@mulch-yard.test').known, false);
    assert.equal(lookupSender(index, 'person@old-record.test').supplier?.id, 's4');
  });

  it('a domain on two suppliers is known but names neither', () => {
    const found = lookupSender(index, 'ap@shared-group.test');
    assert.equal(found.known, true);
    assert.equal(found.ambiguous, true);
    assert.equal(found.supplier, null);
  });

  it('unknown, empty and malformed senders are unknown', () => {
    for (const value of ['billing@new-supplier.test', '', null, undefined, 'not an address']) {
      assert.equal(lookupSender(index, value as string).known, false, String(value));
    }
  });

  it('the env allowlist is an override: known, with no supplier', () => {
    const found = lookupSender(index, 'billing@env-only.test', ['env-only.test']);
    assert.deepEqual(found, { known: true, supplier: null, matchedBy: 'allowlist', ambiguous: false });
    assert.equal(lookupSender(index, 'x@env-only.test', ['@env-only.test']).known, true);
    assert.equal(lookupSender(index, 'one@freemail-env.test', ['one@freemail-env.test']).known, true);
    // A supplier match still names the supplier when the env lists it too.
    assert.equal(lookupSender(index, 'billing@stone-supplier.test', ['stone-supplier.test']).supplier?.id, 's1');
  });

  it('a free-mail domain in the env allowlist counts for nothing; its exact address does', () => {
    assert.equal(lookupSender(index, 'anyone@hotmail.com', ['hotmail.com']).known, false);
    assert.equal(lookupSender(index, 'anyone@hotmail.com', ['anyone@hotmail.com']).known, true);
  });

  it('inactive suppliers are left out by the loader, not the lookup: an empty index knows nobody', () => {
    assert.equal(lookupSender(buildKnownSenders([]), 'billing@stone-supplier.test').known, false);
  });
});

describe('normaliseSenderEntries', () => {
  it('files addresses and domains apart, lower-cased and de-duplicated', () => {
    const entries = normaliseSenderEntries(
      [' Stone-Supplier.test ', 'Billing@Stone-Supplier.test', '@other.test'],
      ['billing@stone-supplier.test', 'stone-supplier.test']
    );
    assert.deepEqual(entries.emailDomains, ['stone-supplier.test', 'other.test']);
    assert.deepEqual(entries.emailAddresses, ['billing@stone-supplier.test']);
    assert.deepEqual(entries.invalid, []);
  });

  it('reports free-mail domains and junk instead of keeping them', () => {
    const entries = normaliseSenderEntries(['gmail.com', 'owner@gmail.com', 'not a domain', 'a@b']);
    assert.deepEqual(entries.freeMailDomains, ['gmail.com']);
    assert.deepEqual(entries.emailAddresses, ['owner@gmail.com']);
    assert.deepEqual(entries.invalid, ['not a domain', 'a@b']);
  });
});
