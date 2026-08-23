import { describe, expect, it } from 'vitest';
import { API_BASE_URL } from '../lib/apiBase';
import { ticketFullImageSrc, ticketThumbnailSrc } from './ticketImage';

describe('ticket image URL resolution', () => {
  it('prefers the thumbnail while preserving absolute storage URLs', () => {
    expect(ticketThumbnailSrc({
      thumbnailUrl: 'https://storage.example.test/thumb.webp',
      imageUrl: '/uploads/ticket.jpg',
    })).toBe('https://storage.example.test/thumb.webp');
  });

  it('resolves relative originals through the shared API base', () => {
    expect(ticketThumbnailSrc({ imageUrl: '/uploads/ticket.jpg' }))
      .toBe(`${API_BASE_URL}/uploads/ticket.jpg`);
    expect(ticketFullImageSrc({ imageUrl: '/uploads/ticket.pdf' }))
      .toBe(`${API_BASE_URL}/uploads/ticket.pdf`);
  });

  it('returns null when no stored ticket image exists', () => {
    expect(ticketThumbnailSrc({})).toBeNull();
    expect(ticketFullImageSrc(null)).toBeNull();
  });
});
