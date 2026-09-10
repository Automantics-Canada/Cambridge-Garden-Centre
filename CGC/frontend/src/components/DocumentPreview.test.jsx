import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import DocumentPreview from './DocumentPreview';

afterEach(cleanup);

describe('document previews', () => {
  it.each([
    '/uploads/invoice.pdf',
    'https://storage.example/invoice.PDF?signature=abc#page=2',
    '/api/storage/object/ref/invoice%2Epdf?expires=123',
  ])('embeds the complete PDF at %s', src => {
    render(<DocumentPreview src={src} title="Invoice" />);
    const frame = screen.getByTitle('Invoice');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe(src);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('keeps images as images even when query parameters mention PDFs', () => {
    const src = '/invoice.png?download=invoice.pdf';
    render(<DocumentPreview src={src} title="Invoice" />);
    expect(screen.getByRole('img').getAttribute('src')).toBe(src);
  });

  it('shows a missing-document state without requesting the current page', () => {
    render(<DocumentPreview title="Invoice" />);
    expect(screen.getByText('Preview not available')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
