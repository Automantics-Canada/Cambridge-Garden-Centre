import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import { Search, Upload, Inbox } from 'lucide-react';
import toast from 'react-hot-toast';
import { Skeleton } from '../../components/Skeleton';
import { FadeInUp, StaggerContainer, StaggerItem } from '../../components/Animated';
import { ticketThumbnailSrc } from '../../utils/ticketImage';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Select,
} from '../../components/ui';
import { cn } from '../../lib/cn';
import { businessDayOffset, formatDate } from '../../lib/date';
import { formatQuantity } from '../../lib/quantity';

const ACTIVE_IMPORT_STORAGE_KEY = 'cgc:active-spruce-import';

export default function OrdersPage() {
  const [searchParams] = useSearchParams();
  const [orders, setOrders] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgressText, setUploadProgressText] = useState('');
  const [importResult, setImportResult] = useState(null);
  const fileInputRef = useRef(null);
  const pdfInputRef = useRef(null);
  const importPollTimerRef = useRef(null);
  const pollImportRef = useRef(null);
  const completedImportJobsRef = useRef(new Set());

  const [search, setSearch] = useState('');
  const [buyerType, setBuyerType] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [driverId] = useState(searchParams.get('driverId') || '');
  const [hasInvoice, setHasInvoice] = useState('');
  const [hasLinkedTickets, setHasLinkedTickets] = useState('');
  const [uploadFilter, setUploadFilter] = useState('today'); // 'today' | 'yesterday' | 'select'
  const [selectedUploadDate, setSelectedUploadDate] = useState(''); // 'YYYY-MM-DD'

  // Step two of the Spruce import. The PO report is previewed before it is
  // applied, because the PO number decides which invoice lines match which
  // orders — a merge run against the wrong report attaches money to the wrong
  // work, and it is far cheaper to see that than to unpick it.
  const poInputRef = useRef(null);
  const [poPreview, setPoPreview] = useState(null);
  const [poApplyResult, setPoApplyResult] = useState(null);
  const [poFile, setPoFile] = useState(null);
  const [poBusy, setPoBusy] = useState(false);

  // "Select date" with nothing chosen used to send no date at all, so the
  // filter silently fell back to every order ever imported. Nothing is fetched
  // until a date is picked.
  const awaitingDateChoice = uploadFilter === 'select' && !selectedUploadDate;

  const fetchOrders = useCallback(async () => {
    if (awaitingDateChoice) {
      setOrders([]);
      setTotalPages(1);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const apiParams = {
        search,
        buyerType,
        supplierId,
        driverId,
        hasInvoice: hasInvoice === 'yes' ? 'true' : hasInvoice === 'no' ? 'false' : undefined,
        hasLinkedTickets: hasLinkedTickets === 'yes' ? 'true' : hasLinkedTickets === 'no' ? 'false' : undefined,
        limit: 30,
        page
      };

      // Dates are resolved in the yard's timezone, not the browser's or UTC's.
      const dateStr =
        uploadFilter === 'today' ? businessDayOffset(0)
        : uploadFilter === 'yesterday' ? businessDayOffset(-1)
        : selectedUploadDate;

      if (dateStr) {
        apiParams.uploadStartDate = dateStr;
        apiParams.uploadEndDate = dateStr;
      }

      const res = await api.get('/api/orders', { params: apiParams });

      setOrders(res.data?.data || []);
      setTotalPages(res.data?.pagination?.totalPages || 1);
    } catch (err) {
      console.error('Error fetching orders:', err);
      toast.error('Failed to fetch orders');
    } finally {
      setLoading(false);
    }
  }, [awaitingDateChoice, search, buyerType, supplierId, driverId, hasInvoice, hasLinkedTickets, uploadFilter, selectedUploadDate, page]);

  const stopImportTransport = useCallback(() => {
    if (importPollTimerRef.current) clearTimeout(importPollTimerRef.current);
    importPollTimerRef.current = null;
  }, []);

  const finishImport = useCallback((result) => {
    if (completedImportJobsRef.current.has(result.jobId)) return;
    completedImportJobsRef.current.add(result.jobId);
    stopImportTransport();
    localStorage.removeItem(ACTIVE_IMPORT_STORAGE_KEY);
    setImportResult(result);
    setIsUploading(false);
    setUploadProgressText('');

    const counts = result.counts || {};
    if (result.status === 'FAILED') {
      toast.error(result.errorSummary || result.errors?.[0]?.error || 'The PDF import failed.');
    } else if (result.status === 'PARTIAL') {
      toast.error(
        `PDF import needs review: ${counts.created ?? 0} created, ` +
        `${counts.updated ?? 0} updated, ${counts.skipped ?? 0} skipped. ` +
        'Review the details shown on this page.'
      );
    } else {
      toast.success(
        `PDF import complete: ${counts.created ?? 0} created, ` +
        `${counts.updated ?? 0} updated${counts.unchanged ? `, ${counts.unchanged} unchanged` : ''}.`
      );
    }

    if (page !== 1) setPage(1);
    else fetchOrders();
  }, [fetchOrders, page, stopImportTransport]);

  const pollImport = useCallback(async (jobId) => {
    if (completedImportJobsRef.current.has(jobId)) return;
    try {
      const res = await api.get(`/api/orders/import/jobs/${jobId}`);
      const job = res.data;
      setImportResult(job);

      if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(job.status)) {
        finishImport(job);
        return;
      }

      setUploadProgressText(
        job.status === 'PENDING' ? 'Import queued...' : 'Importing report...'
      );
      importPollTimerRef.current = setTimeout(() => pollImportRef.current?.(jobId), 1500);
    } catch (err) {
      console.error('Could not poll PDF import:', err);
      setUploadProgressText('Connection interrupted — checking import status...');
      importPollTimerRef.current = setTimeout(() => pollImportRef.current?.(jobId), 3000);
    }
  }, [finishImport]);

  useEffect(() => {
    pollImportRef.current = pollImport;
  }, [pollImport]);

  useEffect(() => {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(ACTIVE_IMPORT_STORAGE_KEY) || 'null');
    } catch {
      localStorage.removeItem(ACTIVE_IMPORT_STORAGE_KEY);
    }
    if (saved?.jobId) {
      setIsUploading(true);
      setImportResult({ jobId: saved.jobId, fileName: saved.fileName, status: 'PENDING' });
      pollImportRef.current?.(saved.jobId);
    }

    return stopImportTransport;
  }, [stopImportTransport]);

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const isCsv = file.name.toLowerCase().endsWith('.csv');
    const isPdf = file.name.toLowerCase().endsWith('.pdf');

    if (!isCsv && !isPdf) {
      toast.error('Please upload a valid CSV or PDF file');
      return;
    }

    const endpoint = isCsv ? '/api/orders/import' : '/api/orders/import-pdf';

    const formData = new FormData();
    formData.append('file', file);

    setIsUploading(true);
    try {
      const res = await api.post(endpoint, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      if (isPdf) {
        const { jobId } = res.data;
        completedImportJobsRef.current.delete(jobId);
        localStorage.setItem(
          ACTIVE_IMPORT_STORAGE_KEY,
          JSON.stringify({ jobId, fileName: file.name })
        );
        setImportResult({ jobId, fileName: file.name, status: 'PENDING' });
        stopImportTransport();
        setUploadProgressText('Import queued...');
        pollImportRef.current?.(jobId);
      } else {
        toast.success(
          `Import complete! ${res.data?.created ?? 0} created, ${res.data?.updated ?? 0} updated.`
        );
        setIsUploading(false);
        fetchOrders();
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to import file');
      console.error('Import error:', err);
      setIsUploading(false);
      setUploadProgressText('');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (pdfInputRef.current) pdfInputRef.current.value = '';
    }
  };

  const handlePoReportSelected = async (event) => {
    const file = event.target.files?.[0];
    if (poInputRef.current) poInputRef.current.value = '';
    if (!file) return;

    setPoBusy(true);
    setPoFile(file);
    try {
      const formData = new FormData();
      formData.append('file', file);
      // No ?apply, so this only reports what it would do.
      const res = await api.post('/api/orders/merge-po-report', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setPoPreview(res.data);
      setPoApplyResult(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not read the PO report');
      setPoFile(null);
    } finally {
      setPoBusy(false);
    }
  };

  const applyPoReport = async (overwriteConflicts) => {
    if (!poFile) return;
    setPoBusy(true);
    try {
      const formData = new FormData();
      formData.append('file', poFile);
      const res = await api.post(
        `/api/orders/merge-po-report?apply=true${overwriteConflicts ? '&overwriteConflicts=true' : ''}`,
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      if ((res.data.documentsSkipped ?? 0) > 0 || (res.data.lineConflicts?.length ?? 0) > 0) {
        toast.error(
          `PO merge updated ${res.data.documentsUpdated ?? 0} document(s) and skipped ` +
          `${res.data.documentsSkipped ?? 0}. Review the details below.`
        );
        setPoApplyResult(res.data);
      } else {
        toast.success(
          `Merged ${res.data.documentsUpdated} order${res.data.documentsUpdated === 1 ? '' : 's'} ` +
          `(${res.data.linesUpdated} line${res.data.linesUpdated === 1 ? '' : 's'}).`
        );
        setPoPreview(null);
        setPoFile(null);
        setPoApplyResult(null);
      }
      fetchOrders();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Merge failed');
    } finally {
      setPoBusy(false);
    }
  };

  useEffect(() => {
    setPage(1);
  }, [search, buyerType, supplierId, driverId, hasInvoice, hasLinkedTickets, uploadFilter, selectedUploadDate]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchOrders();
    }, 300);

    return () => clearTimeout(timer);
  }, [fetchOrders]);

  const filteredOrders = orders;

  const emptyTitle =
    awaitingDateChoice
      ? 'Pick a date'
      : uploadFilter === 'today'
      ? 'No orders uploaded today'
      : uploadFilter === 'yesterday'
      ? 'No orders uploaded yesterday'
      : selectedUploadDate
      ? `No orders uploaded on ${formatDate(selectedUploadDate + 'T00:00:00', { dateStyle: 'long' })}`
      : 'No orders uploaded on this date';

  const emptyMessage = awaitingDateChoice
    ? 'Choose a date above to see the orders imported that day.'
    : 'Import a Spruce CSV or PDF, or pick a different upload date.';

  return (
    <div className="flex flex-col h-full space-y-6">
      <FadeInUp>
        <PageHeader
          title="Orders"
          subtitle={uploadProgressText || 'Import Spruce orders, then match them to tickets and invoices.'}
          actions={
            <div className="flex items-center gap-2">
              <input
                type="file"
                accept=".csv"
                ref={fileInputRef}
                onChange={handleFileUpload}
                className="hidden"
              />
              <input
                type="file"
                accept=".pdf"
                ref={pdfInputRef}
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button
                variant="primary"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
              >
                {isUploading ? 'Processing...' : (<><Upload size={16} /> Import CSV</>)}
              </Button>
              <Button
                onClick={() => pdfInputRef.current?.click()}
                disabled={isUploading}
              >
                {isUploading ? 'Processing...' : (<><Upload size={16} /> Import PDF</>)}
              </Button>
              <input
                type="file"
                accept=".pdf"
                ref={poInputRef}
                onChange={handlePoReportSelected}
                className="hidden"
              />
              <Button
                onClick={() => poInputRef.current?.click()}
                disabled={isUploading || poBusy}
                title="Step two: merge the Sales Order Item Tracking report onto orders already imported. It is the only Spruce report that carries PO numbers."
              >
                {poBusy ? 'Reading...' : (<><Upload size={16} /> Add PO report</>)}
              </Button>
            </div>
          }
        />
      </FadeInUp>

      {importResult && (
        <FadeInUp>
          <Card className="p-5 space-y-4 border-brand/30">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-ink">PDF import</h3>
                  <Badge
                    tone={
                      importResult.status === 'COMPLETED' ? 'good'
                      : importResult.status === 'PARTIAL' || importResult.status === 'FAILED' ? 'warn'
                      : 'neutral'
                    }
                  >
                    {importResult.status === 'PROCESSING' ? 'Processing' :
                     importResult.status === 'PENDING' ? 'Queued' : importResult.status}
                  </Badge>
                </div>
                <p className="text-[13px] text-muted mt-1">
                  {importResult.fileName || `Job ${importResult.jobId}`}
                </p>
              </div>
              {['COMPLETED', 'PARTIAL', 'FAILED'].includes(importResult.status) && (
                <Button size="sm" onClick={() => setImportResult(null)}>Dismiss</Button>
              )}
            </div>

            {importResult.counts && (
              <div className="flex flex-wrap gap-3">
                {[
                  ['Created', importResult.counts.created ?? 0],
                  ['Updated', importResult.counts.updated ?? 0],
                  ['Unchanged', importResult.counts.unchanged ?? 0],
                  ['Not on report', importResult.counts.absent ?? 0],
                  ['Conflicts', importResult.counts.conflicts ?? 0],
                  ['Skipped', importResult.counts.skipped ?? 0],
                ].map(([label, count]) => (
                  <div key={label} className="rounded-control border border-line px-3 py-2">
                    <span className="tabular text-lg font-semibold text-ink">{count}</span>
                    <span className="ml-2 text-[13px] text-muted">{label}</span>
                  </div>
                ))}
              </div>
            )}

            {(importResult.errorSummary || importResult.errors?.length > 0) && (
              <div className="rounded-control border border-ochre/40 bg-ochre/10 p-3">
                <p className="text-[13px] font-semibold text-ink">Details requiring review</p>
                {importResult.errorSummary && !importResult.errors?.length && (
                  <p className="text-[13px] text-muted mt-1">{importResult.errorSummary}</p>
                )}
                {importResult.errors?.length > 0 && (
                  <ul className="text-[13px] text-muted mt-2 space-y-1 max-h-48 overflow-y-auto">
                    {importResult.errors.map((error, index) => (
                      <li key={`${error.rowNumber}-${index}`}>
                        {error.rowNumber ? `Row ${error.rowNumber}: ` : ''}{error.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>
        </FadeInUp>
      )}

      {poPreview && (
        <FadeInUp>
          <Card className="p-5 space-y-4 border-brand/30">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-ink">PO report — nothing written yet</h3>
                <p className="text-[13px] text-muted mt-1 max-w-2xl">
                  Matched on Spruce document number. Review before applying: the PO number
                  decides which invoice lines match which orders.
                </p>
              </div>
              <Button size="sm" onClick={() => { setPoPreview(null); setPoFile(null); setPoApplyResult(null); }}>
                Cancel
              </Button>
            </div>

            <div className="flex flex-wrap gap-3">
              {[
                ['Will be set', poPreview.toSet?.length ?? 0, 'good'],
                ['Already correct', poPreview.unchanged?.length ?? 0, 'neutral'],
                ['Multiple POs', poPreview.multiPo?.length ?? 0, 'neutral'],
                ['Conflicts', poPreview.conflicts?.length ?? 0, 'warn'],
                ['Line conflicts', poPreview.lineConflicts?.length ?? 0, 'warn'],
                ['Order not found', poPreview.unmatched?.length ?? 0, 'warn'],
                ['Unreadable rows', poPreview.unreadable?.length ?? 0, 'warn'],
              ].map(([label, count, tone]) => (
                <div key={label} className="flex items-center gap-2 rounded-control border border-line px-3 py-2">
                  <span className="tabular text-lg font-semibold text-ink">{count}</span>
                  <span className="text-[13px] text-muted">{label}</span>
                  {count > 0 && tone === 'warn' && <Badge tone="warn">check</Badge>}
                </div>
              ))}
            </div>

            {poPreview.conflicts?.length > 0 && (
              <div className="rounded-control border border-ochre/40 bg-ochre/10 p-3">
                <p className="text-[13px] font-semibold text-ink mb-2">
                  These orders already carry a different PO number
                </p>
                <ul className="text-[13px] text-muted space-y-1 max-h-40 overflow-y-auto">
                  {poPreview.conflicts.slice(0, 25).map((c) => (
                    <li key={c.documentNumber} className="tabular">
                      {c.documentNumber} — {c.customerName}: {c.existingPoNumber} → {c.poNumber}
                    </li>
                  ))}
                </ul>
                <p className="text-[12.5px] text-muted mt-2">
                  Skipped unless you choose to replace them. Replacing re-points any tickets
                  and invoice lines already matched on the old PO.
                </p>
              </div>
            )}

            {poPreview.unmatched?.length > 0 && (
              <p className="text-[13px] text-muted">
                {poPreview.unmatched.length} row(s) reference a document not in the system —
                import that day&apos;s delivery report first.
              </p>
            )}

            {poPreview.multiPo?.length > 0 && (
              <p className="text-[13px] text-muted">
                {poPreview.multiPo.length} document(s) legitimately use multiple POs. Each PO will be
                written only to its matched line; the document-level PO will remain unset.
              </p>
            )}

            {(poApplyResult?.lineConflicts?.length ?? poPreview.lineConflicts?.length ?? 0) > 0 && (
              <div className="rounded-control border border-ochre/40 bg-ochre/10 p-3">
                <p className="text-[13px] font-semibold text-ink mb-2">Line details requiring review</p>
                <ul className="text-[13px] text-muted space-y-1 max-h-40 overflow-y-auto">
                  {(poApplyResult?.lineConflicts ?? poPreview.lineConflicts).slice(0, 50).map((conflict, index) => (
                    <li key={`${conflict.documentNumber}-${conflict.rowNumber}-${index}`}>
                      {conflict.documentNumber}, row {conflict.rowNumber}: {conflict.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => applyPoReport(false)}
                disabled={poBusy || (
                  (poPreview.toSet?.length ?? 0) +
                  (poPreview.unchanged?.length ?? 0) +
                  (poPreview.multiPo?.length ?? 0)
                ) === 0}
              >
                {poBusy ? 'Merging...' : `Apply matched lines in ${
                  (poPreview.toSet?.length ?? 0) +
                  (poPreview.unchanged?.length ?? 0) +
                  (poPreview.multiPo?.length ?? 0)
                } document(s)`}
              </Button>
              {((poPreview.conflicts?.length ?? 0) + (poPreview.lineConflicts?.length ?? 0)) > 0 && (
                <Button onClick={() => applyPoReport(true)} disabled={poBusy}>
                  Apply and replace recorded PO/supplier conflicts
                </Button>
              )}
            </div>
          </Card>
        </FadeInUp>
      )}

      <FadeInUp delay={0.1}>
        <Card className="p-4 space-y-4">
          <div className="flex flex-wrap gap-4 items-end">
            <div className="w-full sm:w-auto flex-1 min-w-[200px]">
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Search</label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <Search className="h-4 w-4 text-muted" aria-hidden="true" />
                </div>
                <Input
                  type="text"
                  className="pl-10"
                  placeholder="Order ID, PO, customer, product..."
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                />
              </div>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Upload date</label>
              <div className="flex items-center gap-1 bg-ink/[0.05] p-1 rounded-control">
                {[
                  ['today', 'Today'],
                  ['yesterday', 'Yesterday'],
                  ['select', 'Select date'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setUploadFilter(id)}
                    className={cn(
                      'px-3 py-1.5 rounded-control text-[13px] font-semibold transition-colors',
                      uploadFilter === id
                        ? 'bg-surface text-brand shadow-card border border-line'
                        : 'text-muted hover:text-ink'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {uploadFilter === 'select' && (
              <div>
                <label className="block text-[12.5px] font-medium text-muted mb-1.5">Choose date</label>
                <Input
                  type="date"
                  className="tabular"
                  value={selectedUploadDate}
                  onChange={(e) => setSelectedUploadDate(e.target.value)}
                />
              </div>
            )}

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Buyer type</label>
              <Select
                value={buyerType}
                onChange={(e) => { setBuyerType(e.target.value); setPage(1); }}
              >
                <option value="">All types</option>
                <option value="RETAIL">Retail</option>
                <option value="CONTRACTOR">Contractor</option>
              </Select>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Has invoice?</label>
              <Select
                value={hasInvoice}
                onChange={(e) => setHasInvoice(e.target.value)}
              >
                <option value="">Any</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Has linked tickets?</label>
              <Select
                value={hasLinkedTickets}
                onChange={(e) => setHasLinkedTickets(e.target.value)}
              >
                <option value="">Any</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1.5">Supplier ID</label>
              <Input
                type="text"
                placeholder="UUID"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
              />
            </div>
          </div>
        </Card>
      </FadeInUp>

      <Card className="flex-1 flex flex-col overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line">
            <thead className="bg-ink/[0.03] sticky top-0">
              <tr>
                <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-[12.5px] font-semibold text-muted sm:pl-6 text-nowrap">
                  Spruce ID
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">
                  Customer
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">
                  Buyer type
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted text-nowrap">
                  Product
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">
                  Quantity
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">
                  Supplier
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">
                  Order date
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted">
                  Tickets
                </th>
                <th scope="col" className="px-3 py-3.5 text-left text-[12.5px] font-semibold text-muted text-nowrap">
                  Invoice
                </th>
              </tr>
            </thead>

            <StaggerContainer component="tbody" className="divide-y divide-line bg-surface">
              {loading ? (
                <OrdersTableSkeleton />
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <EmptyState
                      icon={Inbox}
                      title={emptyTitle}
                      message={emptyMessage}
                    />
                  </td>
                </tr>
              ) : (
                filteredOrders.map((order) => {
                  const hasGaps = !order.poNumber && (!order.ticketMatches || order.ticketMatches.length === 0);

                  return (
                    <StaggerItem
                      key={order.id}
                      component="tr"
                      className={hasGaps ? 'bg-ochre/10 hover:bg-ochre/15' : 'hover:bg-brand/[0.04]'}
                    >
                      <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm sm:pl-6">
                        <div className="font-medium text-ink flex items-center gap-2">
                          {order.spruceOrderId}
                          {hasGaps && (
                            <Badge tone="warn">Needs attention</Badge>
                          )}
                        </div>
                        <div className="text-muted text-[13px]">
                          PO: {order.poNumber || <span className="text-clay font-medium">None</span>}
                        </div>
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm text-ink font-medium">
                        {order.customerName}
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm">
                        <Badge tone="neutral">{order.buyerType || 'Not recorded'}</Badge>
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm text-ink">
                        {order.product}
                      </td>

                      <td className="tabular whitespace-nowrap px-3 py-4 text-sm text-muted font-medium">
                        {formatQuantity(order.quantity, order.unit)}
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm text-muted">
                        {order.supplier?.name || '-'}
                      </td>

                      <td className="tabular whitespace-nowrap px-3 py-4 text-sm text-muted">
                        {formatDate(order.orderDate)}
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm">
                        <div className="flex -space-x-2 overflow-hidden">
                          {order.ticketMatches?.length > 0 ? (
                            order.ticketMatches.map(match => (
                              <div
                                key={match.id}
                                className="inline-block h-8 w-8 rounded-pill ring-2 ring-surface bg-ink/[0.06] overflow-hidden border border-line"
                                title={`Ticket: ${match.ticket.ticketNumber || 'N/A'}`}
                              >
                                {match.ticket.imageUrl ? (
                                  <img
                                    src={ticketThumbnailSrc(match.ticket)}
                                    className="h-full w-full object-cover"
                                    alt="Ticket"
                                  />
                                ) : (
                                  <div className="h-full w-full flex items-center justify-center bg-ink/[0.08]">
                                    <span className="text-[12.5px] font-semibold text-muted">T</span>
                                  </div>
                                )}
                              </div>
                            ))
                          ) : (
                            <span className="text-[12.5px] text-muted">No tickets</span>
                          )}
                        </div>
                      </td>

                      <td className="whitespace-nowrap px-3 py-4 text-sm">
                        {order.hasInvoice ? (
                          <div className="flex flex-col">
                            <Badge tone="good">Invoiced</Badge>
                            <span className="tabular text-[12.5px] text-muted mt-1">
                              {order.invoiceNumber || ''}
                            </span>
                          </div>
                        ) : (
                          <Badge tone="warn">Waiting</Badge>
                        )}
                      </td>
                    </StaggerItem>
                  );
                })
              )}
            </StaggerContainer>
          </table>
        </div>
      </Card>

      <Card className="px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between">
          <div className="flex flex-1 justify-between sm:hidden">
            <Button
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Previous
            </Button>
            <Button
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </div>
          <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
            <p className="tabular text-sm text-muted">
              Showing page <span className="font-medium text-ink">{page}</span> of <span className="font-medium text-ink">{totalPages}</span>
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                Previous
              </Button>
              <Button
                size="sm"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function OrdersTableSkeleton() {
  return (
    <>
      {[...Array(10)].map((_, i) => (
        <tr key={i}>
          <td className="whitespace-nowrap py-4 pl-4 pr-3 sm:pl-6">
            <Skeleton variant="text" width="120px" height="16px" />
            <Skeleton variant="text" width="80px" height="12px" className="mt-1" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="text" width="140px" height="16px" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="rectangle" width="80px" height="20px" className="rounded-pill" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="text" width="100px" height="16px" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="text" width="60px" height="16px" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="text" width="100px" height="16px" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="text" width="80px" height="16px" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="rectangle" width="40px" height="24px" className="rounded-pill" />
          </td>
          <td className="whitespace-nowrap px-3 py-4">
            <Skeleton variant="rectangle" width="70px" height="20px" className="rounded-pill" />
          </td>
        </tr>
      ))}
    </>
  );
}
