import { describe, expect, it } from 'vitest';
import { canSetSupplierSenders, isFreeMailDomain, joinSenderEntries, senderEntriesError, splitSenderEntries } from './emailSenders';

describe('supplier email senders', () => {
  it('sorts one box into domains and full addresses', () => {
    expect(splitSenderEntries(' Supplier.example, billing@Supplier.example; @other.example  owner@gmail.com')).toEqual({
      emailDomains: ['supplier.example', 'other.example'],
      emailAddresses: ['billing@supplier.example', 'owner@gmail.com'],
      invalid: [],
      freeMailDomains: [],
    });
  });

  it('refuses a shared mail domain and says to use the full address', () => {
    expect(isFreeMailDomain('Gmail.com')).toBe(true);
    expect(isFreeMailDomain('yahoo.ca')).toBe(true);
    expect(isFreeMailDomain('supplier.example')).toBe(false);
    expect(senderEntriesError('supplier.example, hotmail.com')).toBe(
      'hotmail.com is shared by many senders. Enter the full address instead, e.g. name@hotmail.com.'
    );
    expect(senderEntriesError('not-a-domain, a@b')).toBe('Not a domain or email address: not-a-domain, a@b');
    expect(senderEntriesError('')).toBeNull();
    expect(senderEntriesError('owner@gmail.com')).toBeNull();
  });

  it('shows a saved supplier with domains first, then addresses', () => {
    expect(joinSenderEntries({ emailDomains: ['supplier.example'], emailAddresses: ['owner@gmail.com'] }))
      .toBe('supplier.example, owner@gmail.com');
    expect(joinSenderEntries(null)).toBe('');
  });
});

describe('who sets a supplier\'s senders', () => {
  it('owners and admins only: the senders decide whose invoices are read automatically', () => {
    expect(canSetSupplierSenders('OWNER')).toBe(true);
    expect(canSetSupplierSenders('ADMIN')).toBe(true);
    expect(canSetSupplierSenders('AP_USER')).toBe(false);
    expect(canSetSupplierSenders('DRIVER')).toBe(false);
    expect(canSetSupplierSenders(undefined)).toBe(false);
  });
});
