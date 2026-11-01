/**
 * Re-checks a supplier's open invoices after its agreed rates change.
 *
 * Runs in the background: the person saving a rate or a price list gets their
 * answer at once, and the invoice lines catch up a moment later. A failure is
 * logged, never thrown, because the rate change has already been saved and is
 * right; a stale verdict is picked up by the next change or a manual re-run.
 *
 * One pass per supplier at a time. A change that arrives while a pass is
 * running asks for one more pass afterwards, so the last change is never the
 * one that gets skipped.
 */
import { recomputeInvoiceLinesForSupplier } from '../matching/matching.service.js';
import { refreshInvoiceTotalCheck } from '../invoices/invoice.service.js';

const running = new Map<string, Promise<void>>();
const again = new Set<string>();

/** One pass: re-match the open lines, then re-check each invoice's total. */
export async function recheckSupplierInvoices(
  supplierId: string
): Promise<{ lines: number; invoices: number; capped: boolean }> {
  const result = await recomputeInvoiceLinesForSupplier(supplierId);
  for (const invoiceId of result.invoiceIds) {
    await refreshInvoiceTotalCheck(invoiceId);
  }
  return { lines: result.lines, invoices: result.invoiceIds.length, capped: result.capped };
}

async function runPasses(supplierId: string, context: string): Promise<void> {
  do {
    again.delete(supplierId);
    try {
      const counts = await recheckSupplierInvoices(supplierId);
      console.log(
        `[Rates] ${context}: re-checked ${counts.lines} open invoice line(s) on ${counts.invoices} invoice(s)` +
          (counts.capped ? ' (limit reached: older invoices were not re-checked; re-run them from the invoice page)' : '') +
          '.'
      );
    } catch (error) {
      console.error(`[Rates] ${context}: re-checking open invoices failed:`, error);
    }
  } while (again.has(supplierId));
}

/** Starts a background re-check for this supplier, or queues one more pass. */
export function scheduleRateRecheck(supplierId: string, context: string): void {
  if (running.has(supplierId)) {
    again.add(supplierId);
    return;
  }
  const pass = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => runPasses(supplierId, context))
    .finally(() => running.delete(supplierId));
  running.set(supplierId, pass);
}

/** Resolves once every scheduled re-check has finished. For tests and shutdown. */
export async function waitForRateRechecks(): Promise<void> {
  while (running.size > 0) {
    await Promise.all([...running.values()]);
  }
}
