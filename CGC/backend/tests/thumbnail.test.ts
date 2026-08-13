/**
 * Thumbnail generation.
 *
 * All fixtures are synthesised in-process by sharp. No client image, no
 * production object, and nothing checked into the repository.
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import sharp from 'sharp';
import {
  generateThumbnail,
  deriveThumbnailPath,
  storagePathFromPublicUrl,
  ThumbnailError,
  THUMBNAIL_SIZE,
} from '../src/services/thumbnail.service.js';

/** A synthetic photo roughly the shape a phone camera produces. */
async function syntheticPhoto(format: 'jpeg' | 'png' | 'webp', width = 1800, height = 2391) {
  const base = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 27, g: 67, b: 50 },
    },
  });
  if (format === 'jpeg') return base.jpeg({ quality: 90 }).toBuffer();
  if (format === 'png') return base.png().toBuffer();
  return base.webp().toBuffer();
}

describe('generateThumbnail', () => {
  it('produces a 128x128 WebP from a JPEG', async () => {
    const source = await syntheticPhoto('jpeg');
    const result = await generateThumbnail(source);

    assert.equal(result.width, THUMBNAIL_SIZE);
    assert.equal(result.height, THUMBNAIL_SIZE);
    assert.equal(result.sourceFormat, 'jpeg');

    const meta = await sharp(result.buffer).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, THUMBNAIL_SIZE);
    assert.equal(meta.height, THUMBNAIL_SIZE);
  });

  it('accepts PNG and WebP sources', async () => {
    for (const format of ['png', 'webp'] as const) {
      const result = await generateThumbnail(await syntheticPhoto(format));
      assert.equal((await sharp(result.buffer).metadata()).format, 'webp');
    }
  });

  it('is dramatically smaller than the source', async () => {
    const source = await syntheticPhoto('jpeg');
    const result = await generateThumbnail(source);
    assert.ok(
      result.bytes < result.sourceBytes,
      `expected ${result.bytes} < ${result.sourceBytes}`
    );
  });

  it('applies EXIF orientation and does not carry the tag through', async () => {
    // orientation 6 means "rotate 90deg clockwise on display". A viewer that
    // ignores EXIF would show the raw pixels sideways, so the rotation must be
    // baked in and the tag dropped.
    const landscape = await sharp({
      create: { width: 400, height: 200, channels: 3, background: { r: 200, g: 10, b: 10 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const result = await generateThumbnail(landscape);
    const meta = await sharp(result.buffer).metadata();

    assert.equal(meta.width, THUMBNAIL_SIZE);
    assert.equal(meta.height, THUMBNAIL_SIZE);
    assert.ok(
      meta.orientation === undefined || meta.orientation === 1,
      `orientation should be normalised, got ${meta.orientation}`
    );
  });

  it('strips source metadata, including any EXIF GPS', async () => {
    const withExif = await sharp({
      create: { width: 600, height: 600, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .withMetadata({ exif: { IFD0: { Copyright: 'cgc-test', Artist: 'cgc-test' } } })
      .jpeg()
      .toBuffer();

    const result = await generateThumbnail(withExif);
    const meta = await sharp(result.buffer).metadata();

    assert.equal(meta.exif, undefined, 'EXIF must not survive into the thumbnail');
    assert.ok(!result.buffer.toString('latin1').includes('cgc-test'));
  });

  it('rejects an empty buffer', async () => {
    await assert.rejects(() => generateThumbnail(Buffer.alloc(0)), ThumbnailError);
  });

  it('rejects content that is not an image', async () => {
    await assert.rejects(
      () => generateThumbnail(Buffer.from('%PDF-1.7 this is not a raster image', 'ascii')),
      ThumbnailError
    );
  });

  it('rejects an image declaring more pixels than the limit', async () => {
    // Guards against a small file that decodes into an enormous allocation.
    const huge = await sharp({
      create: { width: 12_000, height: 12_000, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    await assert.rejects(() => generateThumbnail(huge), ThumbnailError);
  });
});

describe('deriveThumbnailPath', () => {
  it('maps an original object path into the thumbnail namespace', () => {
    assert.equal(
      deriveThumbnailPath('tickets/abc-123/abc-123-1700000000000.png'),
      'ticket-thumbnails/abc-123/abc-123-1700000000000.webp'
    );
  });

  it('is deterministic, which is what makes the backfill re-runnable', () => {
    const path = 'tickets/x/y-1.jpg';
    assert.equal(deriveThumbnailPath(path), deriveThumbnailPath(path));
  });

  it('preserves the version component of the original key', () => {
    // The timestamp is what lets the object be served immutable.
    assert.match(deriveThumbnailPath('tickets/a/a-1699999999999.jpeg'), /1699999999999\.webp$/);
  });

  it('distinguishes different originals', () => {
    assert.notEqual(
      deriveThumbnailPath('tickets/a/a-1.png'),
      deriveThumbnailPath('tickets/b/b-1.png')
    );
  });

  it('tolerates a leading slash and a missing extension', () => {
    assert.equal(deriveThumbnailPath('/tickets/a/a-1.png'), 'ticket-thumbnails/a/a-1.webp');
    assert.equal(deriveThumbnailPath('tickets/a/noext'), 'ticket-thumbnails/a/noext.webp');
  });

  it('refuses an empty path', () => {
    assert.throws(() => deriveThumbnailPath(''), ThumbnailError);
  });
});

describe('storagePathFromPublicUrl', () => {
  const bucket = 'tickets-and-invoices';

  it('extracts the object path from a public URL', () => {
    assert.equal(
      storagePathFromPublicUrl(
        `https://example.supabase.co/storage/v1/object/public/${bucket}/tickets/a/a-1.png`,
        bucket
      ),
      'tickets/a/a-1.png'
    );
  });

  it('drops a query string', () => {
    assert.equal(
      storagePathFromPublicUrl(
        `https://example.supabase.co/storage/v1/object/public/${bucket}/tickets/a/a-1.png?v=2`,
        bucket
      ),
      'tickets/a/a-1.png'
    );
  });

  it('returns null for anything that is not a public object URL', () => {
    assert.equal(storagePathFromPublicUrl('/uploads/legacy/a.png', bucket), null);
    assert.equal(storagePathFromPublicUrl('https://evil.test/a.png', bucket), null);
    assert.equal(storagePathFromPublicUrl('', bucket), null);
  });
});
