import { EventEmitter } from 'events';

export const orderEventEmitter = new EventEmitter();

// We can define custom event names to ensure type safety (or document them)
export const OrderEvents = {
  PDF_IMPORT_PROGRESS: 'pdf_import_progress',
  PDF_IMPORT_DONE: 'pdf_import_done',
  PDF_IMPORT_ERROR: 'pdf_import_error',
};
