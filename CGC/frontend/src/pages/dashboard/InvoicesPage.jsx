import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api/axios';
import { Search, Eye, AlertCircle, CheckCircle } from 'lucide-react';

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [disputeNote, setDisputeNote] = useState('');

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/invoice');
      setInvoices(res.data);
    } catch (err) {
      console.error('Error fetching invoices:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

  const handleVerify = async (id) => {
    try {
      await api.post(`/invoice/${id}/verify`);
      setSelectedInvoice(null);
      fetchInvoices();
    } catch (err) {
      console.error('Verification failed', err);
      alert('Verification failed');
    }
  };

  const handleDispute = async (id) => {
    if (!disputeNote) {
      alert('Please enter a dispute note');
      return;
    }
    try {
      await api.post(`/invoice/${id}/dispute`, { note: disputeNote });
      setDisputeNote('');
      setSelectedInvoice(null);
      fetchInvoices();
    } catch (err) {
      console.error('Dispute failed', err);
      alert('Dispute failed');
    }
  };

  const fetchInvoiceDetails = async (id) => {
    try {
      const res = await api.get(`/invoice/${id}`);
      setSelectedInvoice(res.data);
    } catch (err) {
      console.error('Error fetching details:', err);
    }
  };

  return (
    <div className="flex flex-col h-full space-y-4 relative">
      <div className="sm:flex sm:items-center justify-between bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
        <div className="sm:flex-auto">
          <h1 className="text-2xl font-semibold text-gray-900">Invoices</h1>
          <p className="mt-2 text-sm text-gray-700">
            Review, verify, or dispute supplier invoices.
          </p>
        </div>
      </div>

      <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-300">
            <thead className="bg-green-50 sticky top-0">
              <tr>
                <th className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900">Invoice Number</th>
                <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Supplier</th>
                <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Date</th>
                <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Total</th>
                <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Status</th>
                <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {loading ? (
                <tr><td colSpan="6" className="py-12 text-center text-gray-500">Loading invoices...</td></tr>
              ) : invoices.length === 0 ? (
                <tr><td colSpan="6" className="py-12 text-center text-gray-500">No invoices found.</td></tr>
              ) : (
                invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-gray-900">{inv.invoiceNumber}</td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">{inv.supplier?.name || '-'}</td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">{new Date(inv.invoiceDate).toLocaleDateString()}</td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">${Number(inv.totalAmount).toFixed(2)}</td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        inv.status === 'VERIFIED' ? 'bg-green-100 text-green-800' :
                        inv.status === 'DISPUTED' ? 'bg-red-100 text-red-800' :
                        'bg-yellow-100 text-yellow-800'
                      }`}>
                        {inv.status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                      <button 
                        onClick={() => fetchInvoiceDetails(inv.id)}
                        className="text-green-600 hover:text-green-900 focus:outline-none flex items-center gap-1"
                      >
                        <Eye className="w-4 h-4"/> Review
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Review Modal */}
      {selectedInvoice && (
        <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="modal-title" role="dialog" aria-modal="true">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => setSelectedInvoice(null)}></div>

            <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

            <div className="inline-block align-bottom bg-white rounded-lg px-4 pt-5 pb-4 text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-6xl sm:w-full sm:p-6 h-[80vh] flex flex-col">
              
              <div className="flex justify-between items-center border-b pb-4 mb-4 flex-shrink-0">
                <h3 className="text-xl leading-6 font-semibold text-gray-900 flex gap-2 items-center" id="modal-title">
                  Review Invoice: {selectedInvoice.invoiceNumber}
                  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    selectedInvoice.status === 'VERIFIED' ? 'bg-green-100 text-green-800' :
                    selectedInvoice.status === 'DISPUTED' ? 'bg-red-100 text-red-800' :
                    'bg-yellow-100 text-yellow-800'
                  }`}>
                    {selectedInvoice.status}
                  </span>
                </h3>
                <button type="button" onClick={() => setSelectedInvoice(null)} className="text-gray-400 hover:text-gray-500">
                  <span className="sr-only">Close</span>
                  <svg className="h-6 w-6" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="flex flex-1 gap-6 overflow-hidden">
                {/* PDF Viewer Side */}
                <div className="flex-1 bg-gray-100 rounded-lg overflow-hidden border">
                  {selectedInvoice.fileUrl ? (
                    <iframe 
                      src={selectedInvoice.fileUrl} 
                      className="w-full h-full"
                      title="Invoice PDF"
                    ></iframe>
                  ) : (
                    <div className="flex items-center justify-center h-full text-gray-500">No Document File Available</div>
                  )}
                </div>

                {/* Data Side */}
                <div className="flex-1 flex flex-col overflow-y-auto pr-2">
                  <h4 className="text-sm font-semibold text-gray-900 mb-2">Extracted Data</h4>
                  <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
                    <div><span className="text-gray-500">Supplier:</span> {selectedInvoice.supplier?.name || '-'}</div>
                    <div><span className="text-gray-500">Date:</span> {new Date(selectedInvoice.invoiceDate).toLocaleDateString()}</div>
                    <div><span className="text-gray-500">Total:</span> ${Number(selectedInvoice.totalAmount).toFixed(2)}</div>
                  </div>

                  <h4 className="text-sm font-semibold text-gray-900 mb-2">Line Items Analysis</h4>
                  <div className="bg-white border rounded-lg overflow-x-auto shadow-sm mb-6">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Desc</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Qty</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Unit Price</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Flag</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {selectedInvoice.lineItems?.map((item) => (
                          <tr key={item.id}>
                            <td className="px-3 py-2 text-xs text-gray-900">{item.description}</td>
                            <td className="px-3 py-2 text-xs text-gray-900">{Number(item.quantity)}</td>
                            <td className="px-3 py-2 text-xs text-gray-900">${Number(item.unitRate)}</td>
                            <td className="px-3 py-2 text-xs">
                              {item.flag === 'OK' ? (
                                <span className="text-green-600 flex items-center gap-1"><CheckCircle className="w-3 h-3"/> OK</span>
                              ) : (
                                <span className="text-red-600 flex items-center gap-1" title={`Matched Rate: ${item.negotiatedRate}`}><AlertCircle className="w-3 h-3"/> {item.flag}</span>
                              )}
                            </td>
                          </tr>
                        ))}
                        {(!selectedInvoice.lineItems || selectedInvoice.lineItems.length === 0) && (
                          <tr><td colSpan="4" className="px-3 py-2 text-center text-xs text-gray-500">No line items extracted.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Actions */}
                  {selectedInvoice.status === 'PENDING_REVIEW' && (
                    <div className="mt-auto border-t pt-4 space-y-4 pb-4">
                      <button
                        onClick={() => handleVerify(selectedInvoice.id)}
                        className="w-full bg-green-600 text-white rounded-md py-2 text-sm font-medium hover:bg-green-700"
                      >
                        Verify Invoice
                      </button>
                      
                      <div>
                        <textarea 
                          className="w-full border rounded-md p-2 text-sm text-gray-900 mb-2" 
                          placeholder="Dispute reasoning..."
                          value={disputeNote}
                          onChange={(e) => setDisputeNote(e.target.value)}
                        />
                        <button
                          onClick={() => handleDispute(selectedInvoice.id)}
                          className="w-full bg-white border border-red-300 text-red-700 rounded-md py-2 text-sm font-medium hover:bg-red-50"
                        >
                          Dispute Invoice
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

            </div>
          </div>
        </div>
      )}

    </div>
  );
}
