import React from 'react';
import { isPdfDocument } from '../lib/documentType';

export default function DocumentPreview({ src, title, className, onClick }) {
  if (!src) return <p className="text-muted">Preview not available</p>;
  return isPdfDocument(src)
    ? <iframe src={src} title={title} className={className} onClick={onClick} />
    : <img src={src} alt={title} className={className} onClick={onClick} />;
}
