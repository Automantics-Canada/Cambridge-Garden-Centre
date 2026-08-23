import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseStoredObjectLocation,
  rewriteStoredDocumentUrls,
  signedStorageProxyUrl,
  toStorageReference,
  verifySignedStorageRequest,
} from '../src/services/storageAccess.js';

describe('private storage references', () => {
  it('round-trips a configured in-bucket path without creating a public URL', () => {
    const reference = toStorageReference('tickets/ticket-1/proof image.jpg');
    assert.equal(reference, 'storage://test-bucket/tickets/ticket-1/proof%20image.jpg');
    assert.deepEqual(parseStoredObjectLocation(reference), {
      bucket: 'test-bucket',
      path: 'tickets/ticket-1/proof image.jpg',
    });
  });

  it('recognises the configured legacy public URL but rejects other origins and buckets', () => {
    assert.deepEqual(
      parseStoredObjectLocation(
        'https://test-project.supabase.co/storage/v1/object/public/test-bucket/invoices/a/file.pdf?download=1',
      ),
      { bucket: 'test-bucket', path: 'invoices/a/file.pdf' },
    );
    assert.equal(
      parseStoredObjectLocation(
        'https://evil.example/storage/v1/object/public/test-bucket/invoices/a/file.pdf',
      ),
      null,
    );
    assert.equal(parseStoredObjectLocation('storage://other-bucket/a.pdf'), null);
  });

  it('issues a short-lived link and rejects tampering or expiry', () => {
    const now = Date.parse('2026-08-23T10:00:00Z');
    const url = signedStorageProxyUrl('storage://test-bucket/invoices/a/file.pdf', now);
    assert.ok(url);
    const parsed = new URL(url, 'https://api.example.test');
    const [, , , , encoded] = parsed.pathname.split('/');
    const expires = parsed.searchParams.get('expires');
    const signature = parsed.searchParams.get('signature');

    assert.deepEqual(verifySignedStorageRequest(encoded, expires, signature, now), {
      bucket: 'test-bucket',
      path: 'invoices/a/file.pdf',
    });
    assert.equal(verifySignedStorageRequest(encoded, expires, `${signature}x`, now), null);
    assert.equal(verifySignedStorageRequest(encoded, expires, signature, now + 61 * 60 * 1000), null);
  });

  it('rewrites nested response fields while preserving local paths and class instances', () => {
    const receivedAt = new Date('2026-08-23T00:00:00Z');
    const response = {
      ticket: { imageUrl: 'storage://test-bucket/tickets/a/image.jpg' },
      localFixture: '/uploads/qa/ticket.png',
      receivedAt,
    };
    const rewritten = rewriteStoredDocumentUrls(response);
    assert.match(rewritten.ticket.imageUrl, /^\/api\/storage\/object\//);
    assert.equal(rewritten.localFixture, '/uploads/qa/ticket.png');
    assert.equal(rewritten.receivedAt, receivedAt);
  });

  it('rejects traversal and malformed encoded paths', () => {
    assert.throws(() => toStorageReference('../secret'));
    assert.equal(parseStoredObjectLocation('storage://test-bucket/a/%E0%A4%A'), null);
  });
});
