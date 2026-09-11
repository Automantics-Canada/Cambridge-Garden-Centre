import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, HelpCircle, RotateCcw, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { checkTally, checkTitle, describeVerdict, orderedChecks } from '../lib/matchVerdict';

/**
 * A match verdict, with the checks that produced it one click away.
 *
 * The badge alone is not the point. The screen this replaces showed a green
 * MATCHED chip that nothing had computed, and the reason that was able to
 * mislead anyone is that there was nothing behind it to look at. Here the
 * status is a lid on the evidence: every check, what it compared, what it
 * found, and by how much it differed.
 *
 * Failures are listed first, because the whole reason a person opens this is
 * the thing that disagreed.
 */

const TONE_STYLES = {
  good: {
    chip: 'bg-brand/12 text-brand border-brand/30',
    icon: Check,
  },
  warn: {
    chip: 'bg-ochre/14 text-ochre border-ochre/35',
    icon: AlertTriangle,
  },
  bad: {
    chip: 'bg-clay/14 text-clay border-clay/35',
    icon: X,
  },
  neutral: {
    chip: 'bg-ink/[0.05] text-muted border-line',
    icon: HelpCircle,
  },
};

function CheckRow({ check }) {
  const failed = !check.passed;
  const hasNumbers = check.expected !== undefined || check.found !== undefined;

  return (
    <li className={cn('py-2 border-t border-line first:border-t-0')}>
      <div className="flex items-start gap-2">
        {failed ? (
          <X className="w-3.5 h-3.5 text-clay mt-0.5 flex-shrink-0" aria-hidden="true" />
        ) : (
          <Check className="w-3.5 h-3.5 text-brand mt-0.5 flex-shrink-0" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className={cn('text-[12.5px] font-semibold', failed ? 'text-clay' : 'text-ink')}>
            {checkTitle(check.name)}
            <span className="sr-only">{failed ? ' failed' : ' passed'}</span>
          </p>
          <p className="text-[12.5px] text-muted mt-0.5">{check.detail}</p>
          {hasNumbers && (
            <p className="text-[12px] text-muted mt-1 tabular">
              expected <span className="font-semibold text-ink">{formatValue(check.expected)}</span>
              {' · '}
              found <span className="font-semibold text-ink">{formatValue(check.found)}</span>
              {typeof check.delta === 'number' && (
                <>
                  {' · '}
                  difference{' '}
                  <span className={cn('font-semibold', failed ? 'text-clay' : 'text-ink')}>
                    {check.delta > 0 ? '+' : ''}
                    {check.delta}
                  </span>
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function formatValue(value) {
  if (value === null || value === undefined) return '—';
  return String(value);
}

/**
 * The decision box.
 *
 * A reason is demanded for rejecting, and for overriding, because those
 * contradict evidence that is already stored — and in six months the note will
 * be the only record of why. Confirming agrees with reasoning that explains
 * itself, so it does not insist.
 */
function ResolveActions({ matchResult, onResolve, onReopen, busy }) {
  const [choice, setChoice] = useState(null);
  const [note, setNote] = useState('');
  const [orderId, setOrderId] = useState('');

  const candidates = matchResult?.candidateOrderIds ?? [];
  const needsOrder = choice === 'OVERRIDDEN';
  const needsNote = choice === 'OVERRIDDEN' || choice === 'REJECTED';
  const canSubmit = choice && (!needsOrder || orderId.trim()) && (!needsNote || note.trim());

  if (matchResult?.resolution) {
    return (
      <div className="px-4 py-3 border-t border-line flex items-center justify-between gap-3">
        <p className="text-[12px] text-muted">
          Settled as <span className="font-semibold text-ink">{matchResult.resolution.toLowerCase()}</span>
          {matchResult.resolutionNote ? ` — ${matchResult.resolutionNote}` : ''}
        </p>
        <button
          type="button"
          onClick={onReopen}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-control border border-line text-[12px] font-semibold text-ink hover:bg-ink/[0.04] disabled:opacity-50"
        >
          <RotateCcw className="w-3 h-3" aria-hidden="true" /> Reopen
        </button>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-t border-line space-y-2">
      <div className="flex flex-wrap gap-2">
        {[
          ['CONFIRMED', 'Confirm'],
          ['OVERRIDDEN', 'Different order'],
          ['REJECTED', 'Reject'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setChoice(choice === value ? null : value)}
            aria-pressed={choice === value}
            className={cn(
              'px-3 py-1.5 rounded-control border text-[12px] font-semibold transition-colors',
              choice === value
                ? 'bg-ink text-surface border-ink'
                : 'border-line text-ink hover:bg-ink/[0.04]'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {needsOrder && (
        <label className="block">
          <span className="text-[12px] text-muted">
            {candidates.length > 0
              ? 'Which of these orders is it?'
              : 'Order this belongs to'}
          </span>
          {candidates.length > 0 ? (
            <select
              value={orderId}
              onChange={(event) => setOrderId(event.target.value)}
              className="mt-1 w-full rounded-control border border-line bg-surface px-2 py-1.5 text-[12.5px] text-ink"
            >
              <option value="">Choose an order…</option>
              {candidates.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={orderId}
              onChange={(event) => setOrderId(event.target.value)}
              placeholder="Order id"
              className="mt-1 w-full rounded-control border border-line bg-surface px-2 py-1.5 text-[12.5px] text-ink"
            />
          )}
        </label>
      )}

      {needsNote && (
        <label className="block">
          <span className="text-[12px] text-muted">Why? This is the record of the decision.</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            className="mt-1 w-full rounded-control border border-line bg-surface px-2 py-1.5 text-[12.5px] text-ink"
          />
        </label>
      )}

      {choice && (
        <button
          type="button"
          disabled={!canSubmit || busy}
          onClick={() => onResolve({ resolution: choice, orderId: orderId.trim() || undefined, note: note.trim() || undefined })}
          className="px-3 py-1.5 rounded-control bg-brand text-surface text-[12px] font-semibold disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Record decision'}
        </button>
      )}
    </div>
  );
}

export default function MatchVerdict({ matchResult, className, onResolve, onReopen, busy = false }) {
  const [open, setOpen] = useState(false);

  const verdict = describeVerdict(matchResult);
  const tone = TONE_STYLES[verdict.tone] ?? TONE_STYLES.neutral;
  const ToneIcon = tone.icon;
  const checks = orderedChecks(matchResult);
  const tally = checkTally(matchResult);
  const canExpand = checks.length > 0;

  return (
    <div className={cn('bg-surface rounded-card border border-line shadow-card', className)}>
      <button
        type="button"
        onClick={() => canExpand && setOpen((value) => !value)}
        aria-expanded={canExpand ? open : undefined}
        disabled={!canExpand}
        className={cn(
          'w-full flex items-start gap-3 p-4 text-left',
          canExpand && 'hover:bg-ink/[0.02] transition-colors'
        )}
      >
        <span
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-1 rounded-pill border text-[12px] font-semibold flex-shrink-0',
            tone.chip
          )}
        >
          <ToneIcon className="w-3 h-3" aria-hidden="true" />
          {verdict.label}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] text-ink">
            {matchResult?.reason || verdict.summary}
          </span>
          {canExpand && (
            <span className="block text-[12px] text-muted mt-0.5">
              {tally.failed === 0
                ? `${tally.total} check${tally.total === 1 ? '' : 's'} passed`
                : `${tally.failed} of ${tally.total} checks failed`}
            </span>
          )}
          {matchResult?.resolution && (
            <span className="block text-[12px] text-muted mt-0.5">
              Resolved{matchResult.resolvedBy?.name ? ` by ${matchResult.resolvedBy.name}` : ''}
            </span>
          )}
        </span>

        {canExpand &&
          (open ? (
            <ChevronDown className="w-4 h-4 text-muted flex-shrink-0 mt-0.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted flex-shrink-0 mt-0.5" aria-hidden="true" />
          ))}
      </button>

      {open && canExpand && (
        <ul className="px-4 pb-3 border-t border-line">
          {checks.map((check, index) => (
            <CheckRow key={`${check.name}-${index}`} check={check} />
          ))}
        </ul>
      )}

      {matchResult && onResolve && (
        <ResolveActions
          matchResult={matchResult}
          onResolve={onResolve}
          onReopen={onReopen}
          busy={busy}
        />
      )}
    </div>
  );
}
