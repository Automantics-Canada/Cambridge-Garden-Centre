import React from 'react';
import { isPdfDocument, isSpreadsheetDocument } from '../lib/documentType';

/**
 * A stored document in place: a PDF embedded whole, an image as an image, and
 * a spreadsheet (an Excel or CSV invoice, A12) as a download, since a browser
 * cannot show one and an <img> of it is a broken picture.
 */
export default function DocumentPreview({ src, title, className, onClick }) {
  if (!src) return <p className="text-muted">Preview not available</p>;
  if (isSpreadsheetDocument(src)) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-6 text-center" onClick={onClick}>
        <p className="text-sm text-muted">This is a spreadsheet. Download it to open it in Excel.</p>
        <a
          href={src}
          download
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-brand underline"
          onClick={(event) => event.stopPropagation()}
        >
          Download {title ? title.toLowerCase() : 'file'}
        </a>
      </div>
    );
  }
  return isPdfDocument(src)
    ? <iframe src={src} title={title} className={className} onClick={onClick} />
    : <img src={src} alt={title} className={className} onClick={onClick} />;
}
