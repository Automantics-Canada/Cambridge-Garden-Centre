import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import { supabase } from '../../supabaseClient';
import {
  ArrowLeft,
  CheckCircle,
  AlertCircle,
  FileText,
  History,
  Flag,
  Info
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Skeleton } from '../../components/Skeleton';
import {
  Badge,
  Button,
  Card,
  StatusBadge,
  Textarea,
} from '../../components/ui';
import { cn } from '../../lib/cn';

const FLAG_ICONS = {
  OK: <CheckCircle className="w-3 h-3" />,
  RATE_MISMATCH: <AlertCircle className="w-3 h-3" />,
  QTY_MISMATCH: <AlertCircle className="w-3 h-3" />,
  NO_TICKET: <Flag className="w-3 h-3" />,
  NO_ORDER: <Info className="w-3 h-3" />,
  RATE_UNKNOWN: <Info className="w-3 h-3" />,
  MULTIPLE_FLAGS: <AlertCircle className="w-3 h-3" />
};

export default function InvoiceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [disputeNote, setDisputeNote] = useState('');
  const [reopenReason, setReopenReason] = useState('');
  const [showReopenDialog, setShowReopenDialog] = useState(false);

  const fetchInvoice = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};

      const { data, error } = await supabase.functions.invoke(`fetch-cgc-data?resource=invoice-details&id=${id}`, {
        method: 'GET',
        headers
      });

      if (error) throw error;

      setInvoice(data);
      if (data?.disputeNote) setDisputeNote(data.disputeNote);
    } catch (err) {
      toast.error('Failed to load invoice details');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchInvoice();
  }, [fetchInvoice]);

  const handleVerify = async () => {
    try {
      await api.post(`/api/invoices/${id}/verify`);
      toast.success('Invoice verified successfully');
      fetchInvoice();
    } catch (err) {
      toast.error('Verification failed');
    }
  };

  const handleDispute = async () => {
    if (!disputeNote) {
      toast.error('Please enter a note describing the dispute');
      return;
    }
    try {
      await api.post(`/api/invoices/${id}/dispute`, { note: disputeNote });
      toast.success('Invoice marked as disputed');
      fetchInvoice();
    } catch (err) {
      toast.error('Action failed');
    }
  };

  const handleReopen = async () => {
    if (!reopenReason) {
      toast.error('Please enter a reason for reopening');
      return;
    }
    try {
      await api.post(`/api/invoices/${id}/reopen`, { reason: reopenReason });
      toast.success('Invoice reopened for review');
      setShowReopenDialog(false);
      setReopenReason('');
      fetchInvoice();
    } catch (err) {
      toast.error('Reopening failed');
    }
  };

  const handleBack = () => {
    if (window.history.length > 2) {
      navigate(-1);
    } else {
      const statusParam = invoice?.status ? `?status=${invoice.status}` : '';
      navigate(`/dashboard/invoices${statusParam}`);
    }
  };

  if (loading) return <InvoiceDetailSkeleton />;
  if (!invoice) return (
    <div className="p-8 text-center bg-surface rounded-card border border-line">
      <h2 className="text-xl font-semibold mb-4 text-ink">Invoice not found</h2>
      <button onClick={handleBack} className="text-brand font-medium">Back to invoices</button>
    </div>
  );

  const isLocked = invoice.status === 'VERIFIED' || invoice.status === 'DISPUTED';

  // Logic: Calculate expected subtotal using negotiated rates (fallback to billed rate if unknown)
  const expectedSubtotal = invoice.lineItems?.reduce((acc, item) => {
    const rate = Number(item.negotiatedRate || item.unitRate || 0);
    return acc + (Number(item.quantity || 0) * rate);
  }, 0) || 0;

  const expectedTotalWithHST = expectedSubtotal * 1.13;
  const discrepancy = Number(invoice.totalAmount || 0) - expectedTotalWithHST;

  // Approved total is what we expect to pay
  const approvedTotal = expectedTotalWithHST;

  return (
    <div className="flex flex-col h-full space-y-4">
      <Card className="flex-shrink-0">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-4">
            <button
              onClick={handleBack}
              className="p-2 hover:bg-ink/[0.05] rounded-control text-muted transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-ink flex items-center gap-2">
                Invoice: {invoice.invoiceNumber}
                <StatusBadge status={invoice.status} />
              </h1>
              <p className="text-sm text-muted">
                {invoice.supplier?.name} · Received {new Date(invoice.receivedAt).toLocaleDateString()}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isLocked && (
              <button
                onClick={() => setShowReopenDialog(true)}
                className="px-4 py-2 text-sm font-medium text-ink bg-surface border border-line rounded-pill hover:bg-ink/[0.03] flex items-center gap-2 transition-all"
              >
                <History className="w-4 h-4" /> Reopen
              </button>
            )}
          </div>
        </div>
      </Card>

      <div className="flex-1 flex gap-4 min-h-0">
        <Card className="flex-1 overflow-hidden flex flex-col relative">
          <div className="bg-ink/[0.03] border-b border-line px-4 py-2 flex items-center justify-between">
            <span className="text-[12.5px] font-medium text-muted flex items-center gap-1">
              <FileText className="w-3 h-3" /> Original document
            </span>
          </div>
          <div className="flex-1 overflow-hidden bg-ink/[0.04] flex items-center justify-center p-4">
            {invoice.fileUrl ? (
              invoice.fileUrl.toLowerCase().endsWith('.pdf') ? (
                <iframe
                  src={invoice.fileUrl.startsWith('http') ? invoice.fileUrl : `https://cambridge-garden-centre-1.onrender.com${invoice.fileUrl}`}
                  className="w-full h-full border-none rounded-control shadow-card"
                  title="Invoice Document"
                ></iframe>
              ) : (
                <img
                  src={invoice.fileUrl.startsWith('http') ? invoice.fileUrl : `https://cambridge-garden-centre-1.onrender.com${invoice.fileUrl}`}
                  className="max-w-full max-h-full object-contain shadow-card rounded-control"
                  alt="Invoice Document"
                />
              )
            ) : (
              <div className="text-muted">Preview not available</div>
            )}
          </div>
        </Card>

        <div className="w-[45%] flex flex-col gap-4 min-h-0">
          <Card className="overflow-hidden flex flex-col min-h-0">
            <div className="bg-ink/[0.03] border-b border-line px-4 py-2 flex items-center justify-between flex-shrink-0">
              <span className="text-[12.5px] font-medium text-muted">Analysis and match results</span>
            </div>

            <div className="p-4 overflow-y-auto space-y-6">
              <div className="grid grid-cols-2 gap-y-4 gap-x-8 text-sm border-b border-line pb-6">
                <div>
                  <p className="text-muted text-[12.5px] mb-1">Invoice date</p>
                  <p className="tabular font-semibold text-ink">{new Date(invoice.invoiceDate).toLocaleDateString()}</p>
                </div>
                <div>
                  <p className="text-muted text-[12.5px] mb-1">Total amount</p>
                  <p className="tabular font-semibold text-lg text-ink">${Number(invoice.totalAmount).toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-muted text-[12.5px] mb-1">Sender email</p>
                  <p className="font-medium text-ink truncate" title={invoice.emailFrom}>{invoice.emailFrom}</p>
                </div>
                <div>
                  <p className="text-muted text-[12.5px] mb-1">Due date</p>
                  <p className="tabular font-medium text-ink">{invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : 'N/A'}</p>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-ink flex items-center justify-between">
                  Line item analysis
                  <span className="text-[13px] font-normal text-muted">{invoice.lineItems?.length || 0} items extracted</span>
                </h3>

                <div className="space-y-3">
                  {invoice.lineItems?.map((item) => (
                    <div
                      key={item.id}
                      className={cn(
                        'p-3 rounded-control border',
                        item.flag !== 'OK' ? 'border-clay/30 bg-clay/[0.06]' : 'border-line bg-surface'
                      )}
                    >
                      <div className="flex justify-between items-start mb-2 gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-ink leading-tight">{item.description}</p>
                          <p className="text-[13px] text-muted mt-0.5">PO: {item.poNumber || 'Missing'}</p>
                        </div>
                        <span className="flex items-center gap-1.5 flex-none">
                          {FLAG_ICONS[item.flag]}
                          <StatusBadge status={item.flag} />
                        </span>
                      </div>

                      <div className="grid grid-cols-3 gap-2 text-[13px]">
                        <div className="bg-ink/[0.03] p-1.5 rounded-control">
                          <p className="text-muted text-[12.5px]">Billed qty</p>
                          <p className="tabular font-medium text-ink">{item.quantity} {item.unit}</p>
                        </div>
                        <div className="bg-ink/[0.03] p-1.5 rounded-control">
                          <p className="text-muted text-[12.5px]">Billed rate</p>
                          <p className="tabular font-medium text-ink">${Number(item.unitRate).toFixed(2)}</p>
                        </div>
                        <div className={cn(
                          'p-1.5 rounded-control',
                          item.rateDiscrepancy > 0 ? 'bg-clay/14 text-ink border border-clay/30' : 'bg-ink/[0.03]'
                        )}>
                          <p className="text-muted text-[12.5px]">Negotiated</p>
                          <p className="tabular font-medium text-ink">{item.negotiatedRate ? `$${Number(item.negotiatedRate).toFixed(2)}` : 'Unknown'}</p>
                        </div>
                      </div>

                      {item.flag !== 'OK' && (
                        <div className="mt-2 pt-2 border-t border-line space-y-1">
                           {item.flag === 'RATE_MISMATCH' && (
                             <p className="text-[12.5px] text-clay font-medium flex items-center gap-1">
                               <AlertCircle className="w-3 h-3" /> Billed rate exceeds negotiated rate by ${Number(item.rateDiscrepancy).toFixed(2)}
                             </p>
                           )}
                           {item.flag === 'QTY_MISMATCH' && (
                             <p className="text-[12.5px] text-clay font-medium flex items-center gap-1">
                               <AlertCircle className="w-3 h-3" /> Billed quantity exceeds order/ticket quantity by {Number(item.qtyDiscrepancy).toFixed(2)} {item.unit}
                             </p>
                           )}
                           {item.flag === 'NO_TICKET' && (
                             <p className="text-[12.5px] text-ink font-medium flex items-center gap-1">
                               <Flag className="w-3 h-3 text-ochre" /> No matching delivery tickets found for this line item.
                             </p>
                           )}
                           {item.flag === 'NO_ORDER' && (
                             <p className="text-[12.5px] text-ink font-medium flex items-center gap-1">
                               <Info className="w-3 h-3 text-ochre" /> No matching Spruce order found for PO {item.poNumber || 'N/A'}.
                             </p>
                           )}
                           {item.flag === 'RATE_UNKNOWN' && (
                             <p className="text-[12.5px] text-ink font-medium flex items-center gap-1">
                               <Info className="w-3 h-3 text-ochre" /> No negotiated rate on file for this product.
                             </p>
                           )}
                           {item.flag === 'MULTIPLE_FLAGS' && (
                             <p className="text-[12.5px] text-clay font-semibold flex items-center gap-1">
                               <AlertCircle className="w-3 h-3" /> Multiple discrepancies detected. Review carefully.
                             </p>
                           )}
                        </div>
                      )}

                      {item.matchedTickets?.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                          <span className="text-[12.5px] font-medium text-muted mr-1">Tickets:</span>
                          {item.matchedTickets.map(ticket => (
                            <Badge key={ticket.id} tone="neutral" className="gap-1">
                              <FileText className="w-2.5 h-2.5" /> {ticket.ticketNumber || 'Ticket'}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-auto border-t border-line bg-ink/[0.03] p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-surface p-3 rounded-control border border-line">
                  <p className="text-[12.5px] text-muted font-medium">Approved amount</p>
                  <p className="tabular text-lg font-bold text-ink">${Number(approvedTotal).toFixed(2)}</p>
                </div>
                <div className={cn(
                  'p-3 rounded-control border',
                  Math.abs(discrepancy) > 0.01 ? 'bg-clay/14 border-clay/30' : 'bg-surface border-line'
                )}>
                  <p className="text-[12.5px] text-muted font-medium">Discrepancy</p>
                  <p className={cn(
                    'tabular text-lg font-bold',
                    Math.abs(discrepancy) > 0.01 ? 'text-clay' : 'text-ink'
                  )}>
                    ${Number(discrepancy).toFixed(2)}
                  </p>
                </div>
              </div>

              {!isLocked ? (
                <div className="space-y-4">
                   <div className="flex gap-2">
                    <Button
                      variant="primary"
                      onClick={handleVerify}
                      className="flex-1"
                    >
                      <CheckCircle className="w-5 h-5" /> Mark verified
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <Textarea
                      placeholder="Enter dispute notes if marking as disputed..."
                      value={disputeNote}
                      onChange={e => setDisputeNote(e.target.value)}
                    />
                    <Button
                      variant="danger-quiet"
                      onClick={handleDispute}
                      className="w-full"
                    >
                      <AlertCircle className="w-4 h-4" /> Mark disputed
                    </Button>
                  </div>
                </div>
              ) : (
                <div className={cn(
                  'p-4 rounded-control border flex items-center justify-center gap-3',
                  invoice.status === 'VERIFIED'
                    ? 'bg-brand/12 border-brand/30 text-brand'
                    : 'bg-clay/14 border-clay/30 text-clay'
                )}>
                   {invoice.status === 'VERIFIED' ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                   <span className="font-semibold">This invoice is {invoice.status === 'VERIFIED' ? 'verified' : 'disputed'}</span>
                </div>
              )}
            </div>
          </Card>

          <Card className="overflow-hidden flex flex-col h-[200px] flex-shrink-0">
             <div className="bg-ink/[0.03] border-b border-line px-4 py-2 flex items-center justify-between">
                <span className="text-[12.5px] font-medium text-muted flex items-center gap-1"><History className="w-3 h-3"/> Verification log</span>
             </div>
             <div className="p-4 overflow-y-auto text-[13px] space-y-3">
               <div className="flex gap-3">
                 <div className="w-1.5 h-1.5 rounded-pill bg-brand mt-1"></div>
                 <div className="flex-1">
                   <p className="text-ink font-medium">Invoice received and OCR processing started</p>
                   <p className="tabular text-muted mt-0.5">{new Date(invoice.receivedAt).toLocaleString()}</p>
                 </div>
               </div>

               {invoice.ocrJobs?.map(job => (
                 <div key={job.id} className="flex gap-3">
                   <div className={cn(
                     'w-1.5 h-1.5 rounded-pill mt-1',
                     job.status === 'COMPLETED' ? 'bg-brand' : 'bg-clay'
                   )}></div>
                   <div className="flex-1">
                     <p className="text-ink font-medium">OCR Job {job.status.toLowerCase()} by {job.provider}</p>
                     <p className="tabular text-muted mt-0.5">{new Date(job.finishedAt || job.startedAt).toLocaleString()}</p>
                   </div>
                 </div>
               ))}

               {invoice.verifiedAt && (
                  <div className="flex gap-3">
                    <div className={cn(
                      'w-1.5 h-1.5 rounded-pill mt-1',
                      invoice.status === 'VERIFIED' ? 'bg-brand' : 'bg-clay'
                    )}></div>
                    <div className="flex-1">
                      <p className="text-ink font-medium">Invoice marked as {invoice.status} by {invoice.verifiedBy?.name || 'System'}</p>
                      {invoice.disputeNote && <p className="text-ink bg-ink/[0.03] p-2 rounded-control mt-1 border border-line italic">" {invoice.disputeNote} "</p>}
                      <p className="tabular text-muted mt-0.5">{new Date(invoice.verifiedAt).toLocaleString()}</p>
                    </div>
                  </div>
               )}
             </div>
          </Card>
        </div>
      </div>

      {showReopenDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm transition-all">
          <div className="bg-surface rounded-card p-6 shadow-lift border border-line w-full max-w-md animate-in fade-in zoom-in duration-200">
            <h3 className="text-lg font-bold text-ink mb-2">Reopen invoice?</h3>
            <p className="text-sm text-muted mb-4">This will unlock the invoice for further changes and record your reason in the audit trail.</p>
            <Textarea
               className="mb-6"
               placeholder="Reason for reopening..."
               value={reopenReason}
               onChange={e => setReopenReason(e.target.value)}
            />
            <div className="flex gap-3">
              <Button
                onClick={() => setShowReopenDialog(false)}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleReopen}
                className="flex-1"
              >
                Confirm reopen
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function InvoiceDetailSkeleton() {
  return (
    <div className="flex flex-col h-full space-y-4">
      <div className="flex items-center justify-between bg-surface p-4 rounded-card border border-line shadow-card">
        <div className="flex items-center gap-4">
          <Skeleton variant="rectangle" width="40px" height="40px" className="rounded-control" />
          <div className="space-y-2">
            <Skeleton variant="text" width="200px" height="24px" />
            <Skeleton variant="text" width="150px" height="16px" />
          </div>
        </div>
      </div>

      <div className="flex-1 flex gap-4 overflow-hidden">
        <div className="flex-1 bg-surface rounded-card border border-line shadow-card p-4">
          <Skeleton variant="rectangle" height="100%" className="rounded-control" />
        </div>
        <div className="w-[45%] flex flex-col gap-4">
          <div className="bg-surface rounded-card border border-line shadow-card p-6 space-y-6 flex-1">
            <div className="grid grid-cols-2 gap-8">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton variant="text" width="60px" height="12px" />
                  <Skeleton variant="text" width="100px" height="16px" />
                </div>
              ))}
            </div>
            <div className="space-y-4 pt-6 border-t border-line">
              <Skeleton variant="text" width="150px" height="20px" />
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} variant="rectangle" height="100px" className="rounded-control" />
              ))}
            </div>
          </div>
          <div className="bg-surface rounded-card border border-line shadow-card p-4 h-[200px]">
            <Skeleton variant="text" width="120px" height="16px" className="mb-4" />
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton variant="circular" width="12px" height="12px" />
                  <Skeleton variant="text" width="80%" height="12px" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
