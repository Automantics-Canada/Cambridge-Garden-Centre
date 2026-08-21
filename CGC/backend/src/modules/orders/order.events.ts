import { EventEmitter } from 'events';

export const orderEventEmitter = new EventEmitter();

// We can define custom event names to ensure type safety (or document them)
export const OrderEvents = {
  /**
   * A client has opened the progress stream for a job and is listening.
   *
   * The import used to start the moment the upload was accepted, which was
   * safe only because reading the PDF took long enough for the browser to
   * open the stream first. Reading the text layer directly is fast enough to
   * finish before that, and the stream has no backlog — events sent before a
   * client attaches are gone. So the import waits to be heard.
   */
  PDF_IMPORT_ATTACHED: 'pdf_import_attached',
  PDF_IMPORT_PROGRESS: 'pdf_import_progress',
  PDF_IMPORT_DONE: 'pdf_import_done',
  PDF_IMPORT_ERROR: 'pdf_import_error',
};

/**
 * Waits for the progress stream for `jobId` to be opened.
 *
 * Resolves as soon as a client attaches, or after `timeoutMs` if none does.
 * Timing out is deliberate: an upload whose browser tab closed should still be
 * imported, it simply has nobody watching.
 */
export function waitForImportListener(jobId: string, timeoutMs = 3_000): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      orderEventEmitter.off(OrderEvents.PDF_IMPORT_ATTACHED, onAttached);
      resolve();
    };

    const onAttached = (data: { jobId?: string }) => {
      if (data?.jobId === jobId) finish();
    };

    const timer = setTimeout(finish, timeoutMs);
    // Do not hold the process open on this timer alone.
    timer.unref?.();

    orderEventEmitter.on(OrderEvents.PDF_IMPORT_ATTACHED, onAttached);
  });
}
