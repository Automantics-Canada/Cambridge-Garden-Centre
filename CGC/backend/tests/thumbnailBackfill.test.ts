import './setupEnv.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  assertAllowedSource,
  readBoundedBody,
} from '../src/scripts/backfillTicketThumbnails.js';

describe('thumbnail backfill download bounds', () => {
  it('requires the exact configured HTTPS origin', () => {
    assert.doesNotThrow(() =>
      assertAllowedSource('https://test-project.supabase.co/storage/v1/object/public/test-bucket/a.jpg')
    );
    assert.throws(() =>
      assertAllowedSource('https://test-project.supabase.co:444/storage/v1/object/public/test-bucket/a.jpg')
    );
    assert.throws(() =>
      assertAllowedSource('https://evil.test/storage/v1/object/public/test-bucket/a.jpg')
    );
    assert.throws(() =>
      assertAllowedSource('http://test-project.supabase.co/storage/v1/object/public/test-bucket/a.jpg')
    );
  });

  it('stops a streaming response when it exceeds the byte ceiling', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
          controller.close();
        },
      })
    );

    await assert.rejects(() => readBoundedBody(response, 5), /exceeded the 5 byte limit/);
  });

  it('returns a response that stays under the byte ceiling', async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]));
    const result = await readBoundedBody(response, 5);
    assert.deepEqual([...result], [1, 2, 3, 4]);
  });
});

describe('driver ticket thumbnail integration', () => {
  it('routes driver ticket uploads through saveTicketImage and persists thumbnailUrl', async () => {
    const source = await readFile(
      new URL('../src/modules/deliveries/deliveries.service.ts', import.meta.url),
      'utf8'
    );
    assert.match(source, /saveTicketImage\(fileBuffer, filename\)/);
    assert.match(source, /imageUrl,\s*thumbnailUrl,/s);
  });
});
