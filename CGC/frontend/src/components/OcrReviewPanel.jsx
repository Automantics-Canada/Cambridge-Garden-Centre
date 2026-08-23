import React from 'react';
import { AlertTriangle, CircleSlash, Sparkles } from 'lucide-react';
import { Badge } from './ui';
import { cn } from '../lib/cn';

/**
 * What the document reader could and could not establish.
 *
 * A document now finishes in one of three states, and the difference matters to
 * whoever is looking at it:
 *
 *   COMPLETED     every field was read and validated; nothing to do here.
 *   NEEDS_REVIEW  the reader produced a usable result but something needs a
 *                 person — a field it could not resolve, a value it was unsure
 *                 of, or a value that came from the fallback model rather than
 *                 from the page itself.
 *   FAILED        the document could not be read at all.
 *
 * Before this, all three looked identical on screen: the extracted fields simply
 * appeared, filled in, with no indication of which had been read confidently and
 * which had been guessed at or defaulted. The panel exists so that distinction
 * is visible at the point where somebody is about to act on the numbers.
 *
 * It deliberately shows reasons and field names only. Prompts, model responses
 * and provider payloads are not rendered here and are not sent to this screen.
 */

/** Turn `lines.0.unitRate` into `Line 1 — unit rate`. */
function readableField(path) {
  const lineMatch = path.match(/^lines\.(\d+)\.(.+)$/);
  if (lineMatch) {
    return `Line ${Number(lineMatch[1]) + 1} — ${humanise(lineMatch[2])}`;
  }
  return humanise(path);
}

function humanise(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, char => char.toUpperCase())
    .toLowerCase()
    .replace(/^./, char => char.toUpperCase());
}

/** Field paths the reader could not settle, from the stored provenance. */
function unresolvedFields(job) {
  const fields = job?.rawResponse?.fields;
  if (!fields || typeof fields !== 'object') return [];
  return Object.entries(fields)
    .filter(([, detail]) => detail?.state === 'MISSING' || detail?.state === 'INVALID')
    .map(([path]) => path);
}

export function OcrReviewPanel({ ocrJobs, className }) {
  // The most recent job is the one that describes the document's current state.
  const job = Array.isArray(ocrJobs) ? ocrJobs[0] : null;
  if (!job) return null;

  const status = job.status;
  if (status !== 'NEEDS_REVIEW' && status !== 'FAILED') return null;

  const failed = status === 'FAILED';
  const reasons = Array.isArray(job.reviewReasons) ? job.reviewReasons : [];
  const unresolved = unresolvedFields(job);

  return (
    <div
      className={cn(
        'rounded-card border px-4 py-3 space-y-3',
        failed ? 'border-clay/40 bg-clay/[0.06]' : 'border-ochre/40 bg-ochre/[0.08]',
        className
      )}
      role="status"
    >
      <div className="flex items-center gap-2">
        {failed ? (
          <CircleSlash className="w-4 h-4 text-clay shrink-0" />
        ) : (
          <AlertTriangle className="w-4 h-4 text-ochre shrink-0" />
        )}
        <span className="text-[13px] font-semibold text-ink">
          {failed ? 'This document could not be read' : 'This document needs review'}
        </span>
        {job.fallbackUsed && (
          <Badge tone="neutral" className="gap-1">
            <Sparkles className="w-3 h-3" /> Fallback reader used
          </Badge>
        )}
      </div>

      {failed ? (
        <p className="text-[12.5px] text-muted">
          {job.errorMessage || 'No further detail was recorded.'} Nothing was changed on this record.
        </p>
      ) : (
        <p className="text-[12.5px] text-muted">
          The values below were read but not confirmed. Check them against the document before
          verifying.
          {job.fallbackUsed
            ? ' At least one value came from the fallback reader rather than from the scan itself.'
            : ''}
        </p>
      )}

      {reasons.length > 0 && (
        <ul className="space-y-1 text-[12.5px] text-ink">
          {reasons.map(reason => (
            <li key={reason} className="flex gap-2">
              <span aria-hidden className="text-muted">
                •
              </span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}

      {unresolved.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-[12.5px] text-muted">Still unresolved:</span>
          {unresolved.map(path => (
            <Badge key={path} tone="warn">
              {readableField(path)}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export default OcrReviewPanel;
