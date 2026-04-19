import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import { 
  ArrowLeft, 
  CheckCircle, 
  AlertCircle, 
  FileText, 
  History, 
  MoreVertical,
  Flag,
  Info
} from 'lucide-react';
import toast from 'react-hot-toast';
import Loader from '../../components/Loader';

const FLAG_COLORS = {
  OK: 'bg-green-100 text-green-800',
  RATE_MISMATCH: 'bg-red-100 text-red-800',
  QTY_MISMATCH: 'bg-orange-100 text-orange-800',
  NO_TICKET: 'bg-purple-100 text-purple-800 border-purple-200',
  NO_ORDER: 'bg-blue-100 text-blue-800',
  RATE_UNKNOWN: 'bg-gray-100 text-gray-800',
  MULTIPLE_FLAGS: 'bg-red-200 text-red-900 border-red-300'
};

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
      const res = await api.get(`/api/invoices/${id}`);
      setInvoice(res.data);
      if (res.data.disputeNote) setDisputeNote(res.data.disputeNote);
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

  if (loading) return <Loader message="Loading invoice details..." />;
  if (!invoice) return (
    <div className="p-8 text-center bg-white rounded-xl border">
      <h2 className="text-xl font-semibold mb-4 text-gray-900">Invoice not found</h2>
      <button onClick={() => navigate('/dashboard/invoices')} className="text-green-600 font-medium">Back to Invoices</button>
    </div>
  );

  const isLocked = invoice.status === 'VERIFIED' || invoice.status === 'DISPUTED';
  
  // sum all rate and qty discrepancies
  const totalDiscrepancy = invoice.lineItems?.reduce((acc, item) => {
    return acc + (item.rateDiscrepancy || 0) + (Number(item.qtyDiscrepancy || 0) * Number(item.unitRate || 0));
  }, 0) || 0;

  const approvedTotal = invoice.lineItems?.reduce((acc, item) => {
    // Approved = Sum of non-disputed lines (OK flag)
    if (item.flag === 'OK') {
      return acc + Number(item.lineTotal || 0);
    }
    return acc;
  }, 0) || 0;

  return (
    <div className="flex flex-col h-full space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between bg-white p-4 rounded-xl border border-gray-200 shadow-sm flex-shrink-0">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => navigate('/dashboard/invoices')}
            className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              Invoice: {invoice.invoiceNumber}
              <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${
                invoice.status === 'VERIFIED' ? 'bg-green-100 text-green-800' :
                invoice.status === 'DISPUTED' ? 'bg-red-100 text-red-800' :
                'bg-yellow-100 text-yellow-800 border'
              }`}>
                {invoice.status}
              </span>
            </h1>
            <p className="text-sm text-gray-500">{invoice.supplier?.name} • Received {new Date(invoice.receivedAt).toLocaleDateString()}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isLocked && (
            <button 
              onClick={() => setShowReopenDialog(true)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-2 transition-all"
            >
              <History className="w-4 h-4" /> Reopen
            </button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex gap-4 min-h-0">
        {/* Left: Document Viewer */}
        <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col relative">
          <div className="bg-gray-50 border-b px-4 py-2 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500 uppercase flex items-center gap-1">
              <FileText className="w-3 h-3" /> Original Document
            </span>
          </div>
          <div className="flex-1 overflow-hidden bg-gray-100 flex items-center justify-center p-4">
            {invoice.fileUrl ? (
              invoice.fileUrl.toLowerCase().endsWith('.pdf') ? (
                <iframe 
                  src={invoice.fileUrl.startsWith('http') ? invoice.fileUrl : `http://localhost:4000${invoice.fileUrl}`} 
                  className="w-full h-full border-none rounded shadow-lg"
                  title="Invoice Document"
                ></iframe>
              ) : (
                <img 
                  src={invoice.fileUrl.startsWith('http') ? invoice.fileUrl : `http://localhost:4000${invoice.fileUrl}`} 
                  className="max-w-full max-h-full object-contain shadow-lg rounded"
                  alt="Invoice Document"
                />
              )
            ) : (
              <div className="text-gray-400">Preview not available</div>
            )}
          </div>
        </div>

        {/* Right: Data & Analysis */}
        <div className="w-[45%] flex flex-col gap-4 min-h-0">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col min-h-0">
            <div className="bg-gray-50 border-b px-4 py-2 flex items-center justify-between flex-shrink-0">
              <span className="text-xs font-medium text-gray-500 uppercase">Analysis & Match results</span>
            </div>
            
            <div className="p-4 overflow-y-auto space-y-6">
              {/* Metadata */}
              <div className="grid grid-cols-2 gap-y-4 gap-x-8 text-sm border-b pb-6">
                <div>
                  <p className="text-gray-500 text-xs mb-1 uppercase tracking-wider">Invoice Date</p>
                  <p className="font-semibold">{new Date(invoice.invoiceDate).toLocaleDateString()}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs mb-1 uppercase tracking-wider">Total Amount</p>
                  <p className="font-semibold text-lg text-green-700">${Number(invoice.totalAmount).toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs mb-1 uppercase tracking-wider">Sender Email</p>
                  <p className="font-medium truncate" title={invoice.emailFrom}>{invoice.emailFrom}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs mb-1 uppercase tracking-wider">Due Date</p>
                  <p className="font-medium">{invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : 'N/A'}</p>
                </div>
              </div>

              {/* Line Items */}
              <div className="space-y-4">
                <h3 className="text-sm font-bold text-gray-900 flex items-center justify-between">
                  Line Item Analysis
                  <span className="text-xs font-normal text-gray-500">{invoice.lineItems?.length || 0} items extracted</span>
                </h3>
                
                <div className="space-y-3">
                  {invoice.lineItems?.map((item) => (
                    <div key={item.id} className={`p-3 rounded-lg border ${item.flag !== 'OK' ? 'border-red-200 bg-red-50/30' : 'border-gray-200 bg-white shadow-xs'}`}>
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-gray-900 leading-tight">{item.description}</p>
                          <p className="text-xs text-gray-500 mt-0.5">PO: {item.poNumber || 'Missing'}</p>
                        </div>
                        <span className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${FLAG_COLORS[item.flag]}`}>
                          {FLAG_ICONS[item.flag]} {item.flag.replace('_', ' ')}
                        </span>
                      </div>
                      
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div className="bg-gray-50 p-1.5 rounded">
                          <p className="text-gray-400 text-[9px] uppercase font-bold tracking-tighter">Billed Qty</p>
                          <p className="font-medium">{item.quantity} {item.unit}</p>
                        </div>
                        <div className="bg-gray-50 p-1.5 rounded">
                          <p className="text-gray-400 text-[9px] uppercase font-bold tracking-tighter">Billed Rate</p>
                          <p className="font-medium">${Number(item.unitRate).toFixed(2)}</p>
                        </div>
                        <div className={`${item.rateDiscrepancy > 0 ? 'bg-red-100 text-red-900 border-red-200 border' : 'bg-gray-50'} p-1.5 rounded`}>
                          <p className="text-gray-400 text-[9px] uppercase font-bold tracking-tighter">Negotiated</p>
                          <p className="font-medium">{item.negotiatedRate ? `$${Number(item.negotiatedRate).toFixed(2)}` : 'Unknown'}</p>
                        </div>
                      </div>

                      {/* Discrepancy details */}
                      {item.flag !== 'OK' && (
                        <div className="mt-2 pt-2 border-t border-gray-100 space-y-1">
                           {item.flag === 'RATE_MISMATCH' && (
                             <p className="text-[10px] text-red-600 font-medium flex items-center gap-1">
                               <AlertCircle className="w-3 h-3" /> Billed rate exceeds negotiated rate by ${Number(item.rateDiscrepancy).toFixed(2)}
                             </p>
                           )}
                           {item.flag === 'QTY_MISMATCH' && (
                             <p className="text-[10px] text-orange-600 font-medium flex items-center gap-1">
                               <AlertCircle className="w-3 h-3" /> Billed quantity exceeds order/ticket quantity by {Number(item.qtyDiscrepancy).toFixed(2)} {item.unit}
                             </p>
                           )}
                           {item.flag === 'NO_TICKET' && (
                             <p className="text-[10px] text-purple-600 font-medium flex items-center gap-1">
                               <Flag className="w-3 h-3" /> No matching delivery tickets found for this line item.
                             </p>
                           )}
                           {item.flag === 'NO_ORDER' && (
                             <p className="text-[10px] text-blue-600 font-medium flex items-center gap-1">
                               <Info className="w-3 h-3" /> No matching Spruce order found for PO {item.poNumber || 'N/A'}.
                             </p>
                           )}
                           {item.flag === 'RATE_UNKNOWN' && (
                             <p className="text-[10px] text-gray-600 font-medium flex items-center gap-1">
                               <Info className="w-3 h-3" /> No negotiated rate on file for this product.
                             </p>
                           )}
                           {item.flag === 'MULTIPLE_FLAGS' && (
                             <p className="text-[10px] text-red-700 font-bold flex items-center gap-1 uppercase">
                               <AlertCircle className="w-3 h-3" /> Multiple discrepancies detected. Review carefully.
                             </p>
                           )}
                        </div>
                      )}

                      {/* Linked Tickets */}
                      {item.matchedTickets?.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                          <span className="text-[9px] font-bold text-gray-400 uppercase mr-1">Tickets:</span>
                          {item.matchedTickets.map(ticket => (
                            <span key={ticket.id} className="text-[10px] bg-purple-50 text-purple-700 px-2 py-0.5 rounded border border-purple-100 flex items-center gap-1">
                              <FileText className="w-2.5 h-2.5" /> {ticket.ticketNumber || 'Ticket'}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Sticky Summary & Actions */}
            <div className="mt-auto border-t bg-gray-50 p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white p-3 rounded-xl border border-gray-200 shadow-xs">
                  <p className="text-[10px] text-gray-500 uppercase font-bold">Approved Amount</p>
                  <p className="text-lg font-bold text-gray-900">${Number(approvedTotal).toFixed(2)}</p>
                </div>
                <div className={`p-3 rounded-xl border shadow-xs ${totalDiscrepancy > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'}`}>
                  <p className="text-[10px] text-gray-500 uppercase font-bold">Discrepancy</p>
                  <p className={`text-lg font-bold ${totalDiscrepancy > 0 ? 'text-red-600' : 'text-gray-900'}`}>${Number(totalDiscrepancy).toFixed(2)}</p>
                </div>
              </div>

              {!isLocked ? (
                <div className="space-y-4">
                   <div className="flex gap-2">
                    <button 
                      onClick={handleVerify}
                      className="flex-1 bg-green-600 text-white font-bold py-3 rounded-xl hover:bg-green-700 transition-all shadow-md shadow-green-200 flex items-center justify-center gap-2"
                    >
                      <CheckCircle className="w-5 h-5" /> Mark Verified
                    </button>
                  </div>
                  <div className="space-y-2">
                    <textarea 
                      placeholder="Enter dispute notes if marking as disputed..."
                      className="w-full text-sm p-3 border rounded-xl focus:ring-2 focus:ring-red-200 outline-none h-20 transition-all"
                      value={disputeNote}
                      onChange={e => setDisputeNote(e.target.value)}
                    />
                    <button 
                      onClick={handleDispute}
                      className="w-full text-red-600 font-bold py-2 hover:bg-red-50 rounded-xl transition-all flex items-center justify-center gap-2"
                    >
                      <AlertCircle className="w-4 h-4" /> Mark Disputed
                    </button>
                  </div>
                </div>
              ) : (
                <div className={`p-4 rounded-xl border flex items-center justify-center gap-3 ${invoice.status === 'VERIFIED' ? 'bg-green-100 border-green-200 text-green-800' : 'bg-red-100 border-red-200 text-red-800'}`}>
                   {invoice.status === 'VERIFIED' ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                   <span className="font-bold underline">THIS INVOICE IS {invoice.status}</span>
                </div>
              )}
            </div>
          </div>
          
          {/* Internal Log / Verification History */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col h-[200px] flex-shrink-0">
             <div className="bg-gray-50 border-b px-4 py-2 flex items-center justify-between">
                <span className="text-xs font-medium text-gray-500 uppercase flex items-center gap-1"><History className="w-3 h-3"/> Verification Log</span>
             </div>
             <div className="p-4 overflow-y-auto text-xs space-y-3">
               <div className="flex gap-3">
                 <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1 shadow-xs"></div>
                 <div className="flex-1">
                   <p className="text-gray-900 font-medium">Invoice received and OCR processing started</p>
                   <p className="text-gray-400 mt-0.5">{new Date(invoice.receivedAt).toLocaleString()}</p>
                 </div>
               </div>
               
               {invoice.ocrJobs?.map(job => (
                 <div key={job.id} className="flex gap-3">
                   <div className={`w-1.5 h-1.5 rounded-full ${job.status === 'COMPLETED' ? 'bg-green-500' : 'bg-red-500'} mt-1`}></div>
                   <div className="flex-1">
                     <p className="text-gray-900 font-medium">OCR Job {job.status.toLowerCase()} by {job.provider}</p>
                     <p className="text-gray-400 mt-0.5">{new Date(job.finishedAt || job.startedAt).toLocaleString()}</p>
                   </div>
                 </div>
               ))}

               {invoice.verifiedAt && (
                  <div className="flex gap-3">
                    <div className={`w-1.5 h-1.5 rounded-full ${invoice.status === 'VERIFIED' ? 'bg-green-500' : 'bg-red-500'} mt-1`}></div>
                    <div className="flex-1">
                      <p className="text-gray-900 font-medium">Invoice marked as {invoice.status} by {invoice.verifiedBy?.name || 'System'}</p>
                      {invoice.disputeNote && <p className="text-gray-600 bg-gray-50 p-2 rounded mt-1 border border-gray-100 italic">" {invoice.disputeNote} "</p>}
                      <p className="text-gray-400 mt-0.5">{new Date(invoice.verifiedAt).toLocaleString()}</p>
                    </div>
                  </div>
               )}
             </div>
          </div>
        </div>
      </div>

      {/* Reopen Dialog */}
      {showReopenDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm transition-all">
          <div className="bg-white rounded-2xl p-6 shadow-2xl border w-full max-w-md animate-in fade-in zoom-in duration-200">
            <h3 className="text-lg font-bold text-gray-900 mb-2">Reopen Invoice?</h3>
            <p className="text-sm text-gray-500 mb-4">This will unlock the invoice for further changes and record your reason in the audit trail.</p>
            <textarea 
               className="w-full border rounded-xl p-3 text-sm mb-6 h-24 focus:ring-2 focus:ring-green-100 outline-none"
               placeholder="Reason for reopening..."
               value={reopenReason}
               onChange={e => setReopenReason(e.target.value)}
            />
            <div className="flex gap-3">
              <button 
                onClick={() => setShowReopenDialog(false)}
                className="flex-1 py-2 text-sm font-bold text-gray-500 hover:bg-gray-100 rounded-xl transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={handleReopen}
                className="flex-1 py-2 text-sm font-bold text-white bg-gray-900 hover:bg-black rounded-xl transition-all shadow-lg"
              >
                Confirm Reopen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
