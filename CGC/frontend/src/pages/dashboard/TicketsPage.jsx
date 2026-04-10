import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api/axios';
import { 
  Search, 
  Eye, 
  AlertCircle, 
  CheckCircle, 
  Filter, 
  Calendar, 
  FileText, 
  Link as LinkIcon,
  Smartphone,
  Mail,
  X,
  ChevronRight,
  ChevronLeft,
  RotateCcw
} from 'lucide-react';
import toast from 'react-hot-toast';
import Loader from '../../components/Loader';

export default function TicketsPage() {
  const [tickets, setTickets] = useState([]);
  const [stats, setStats] = useState({ unlinkedCount: 0 });
  const [loading, setLoading] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [activeTab, setActiveTab] = useState('ALL'); // ALL, UNLINKED, LINKED
  
  // Filters
  const [search, setSearch] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [source, setSource] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [suppliers, setSuppliers] = useState([]);

  // Linking
  const [orderSearch, setOrderSearch] = useState('');
  const [orderResults, setOrderResults] = useState([]);
  const [searchingOrders, setSearchingOrders] = useState(false);

  const fetchSuppliers = async () => {
    try {
      const res = await api.get('/supplier');
      setSuppliers(res.data);
    } catch (err) {
      console.error('Error fetching suppliers:', err);
    }
  };

  const fetchStats = async () => {
    try {
      const res = await api.get('/ticket/stats');
      setStats(res.data);
    } catch (err) {
      console.error('Error fetching ticket stats:', err);
    }
  };

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        status: activeTab === 'ALL' ? undefined : activeTab,
        search,
        supplierId,
        source,
        startDate,
        endDate
      };
      const res = await api.get('/ticket', { params });
      setTickets(res.data);
    } catch (err) {
      console.error('Error fetching tickets:', err);
      toast.error('Failed to load tickets');
    } finally {
      setLoading(false);
    }
  }, [activeTab, search, supplierId, source, startDate, endDate]);

  useEffect(() => {
    fetchTickets();
    fetchStats();
    fetchSuppliers();
  }, [fetchTickets]);

  const handleUpdateTicket = async (id, data) => {
    try {
      await api.put(`/ticket/${id}`, data);
      toast.success('Ticket updated');
      fetchTickets();
      fetchStats();
      if (selectedTicket?.id === id) {
        // Refresh details
        const res = await api.get(`/ticket/${id}`);
        setSelectedTicket(res.data);
      }
    } catch (err) {
      toast.error('Failed to update ticket');
    }
  };

  const handleLinkToOrder = async (ticketId, orderId) => {
    try {
      await api.post(`/ticket/${ticketId}/link`, { orderId });
      toast.success('Ticket linked to order');
      setSelectedTicket(null);
      fetchTickets();
      fetchStats();
    } catch (err) {
      toast.error('Failed to link ticket');
    }
  };

  const searchOrders = async (query) => {
    if (!query) {
      setOrderResults([]);
      return;
    }
    setSearchingOrders(true);
    try {
      const res = await api.get('/order', { params: { search: query } });
      setOrderResults(res.data);
    } catch (err) {
      console.error('Order search error:', err);
    } finally {
      setSearchingOrders(false);
    }
  };

  return (
    <div className="flex flex-col h-full space-y-4 relative">
      {/* Header & Stats */}
      <div className="sm:flex sm:items-center justify-between bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
        <div className="sm:flex-auto">
          <h1 className="text-2xl font-semibold text-gray-900">Delivery Tickets</h1>
          <p className="mt-2 text-sm text-gray-700">
            Process and link supplier delivery tickets received via WhatsApp and Email.
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex gap-4">
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 flex items-center gap-3">
             <div className="bg-yellow-100 p-2 rounded-full">
                <AlertCircle className="w-5 h-5 text-yellow-600" />
             </div>
             <div>
                <p className="text-xs text-yellow-700 font-medium uppercase tracking-wider">Needs Attention</p>
                <p className="text-xl font-bold text-yellow-900">{stats.unlinkedCount} Unlinked</p>
             </div>
          </div>
        </div>
      </div>

      {/* Tabs & Filters */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="border-b border-gray-200">
          <nav className="flex -mb-px" aria-label="Tabs">
            {[
              { id: 'ALL', name: 'All Tickets' },
              { id: 'UNLINKED', name: 'Unlinked', count: stats.unlinkedCount },
              { id: 'LINKED', name: 'Linked' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  relative min-w-0 flex-1 overflow-hidden py-4 px-4 text-sm font-medium text-center hover:bg-gray-50 focus:z-10 transition-colors
                  ${activeTab === tab.id 
                    ? 'text-green-600 border-b-2 border-green-600 bg-green-50/30' 
                    : 'text-gray-500 border-b-2 border-transparent hover:text-gray-700'}
                `}
              >
                <span className="flex items-center justify-center gap-2">
                  {tab.name}
                  {tab.count !== undefined && (
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${activeTab === tab.id ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                      {tab.count}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </nav>
        </div>

        <div className="p-4 flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-gray-700 mb-1">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input 
                type="text" 
                placeholder="Ticket #, PO, Material..."
                className="w-full pl-10 pr-4 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div className="w-48">
            <label className="block text-xs font-medium text-gray-700 mb-1">Supplier</label>
            <select 
              className="w-full p-2 border rounded-lg text-sm bg-white"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
            >
              <option value="">All Suppliers</option>
              {suppliers.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <div className="w-40">
            <label className="block text-xs font-medium text-gray-700 mb-1">Source</label>
            <select 
              className="w-full p-2 border rounded-lg text-sm"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">All Sources</option>
              <option value="WHATSAPP">WhatsApp</option>
              <option value="EMAIL">Email</option>
            </select>
          </div>

          <div className="w-48">
             <label className="block text-xs font-medium text-gray-700 mb-1">Date Range</label>
             <div className="flex items-center gap-2">
                <input type="date" className="w-full p-2 border rounded-lg text-xs" value={startDate} onChange={e => setStartDate(e.target.value)} />
                <span className="text-gray-400">-</span>
                <input type="date" className="w-full p-2 border rounded-lg text-xs" value={endDate} onChange={e => setEndDate(e.target.value)} />
             </div>
          </div>

          <button 
            onClick={() => {
              setSearch('');
              setSource('');
              setSupplierId('');
              setStartDate('');
              setEndDate('');
            }}
            className="p-2 text-gray-500 hover:text-gray-700 transition-colors"
            title="Clear Filters"
          >
            <RotateCcw className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Tickets Table */}
      <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50 whitespace-nowrap">
              <tr>
                <th colSpan="2" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Ticket / Image</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Supplier</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Material</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Quantity</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">PO #</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr><td colSpan="8" className="px-6 py-12 text-center text-gray-500">Loading tickets...</td></tr>
              ) : tickets.length === 0 ? (
                <tr><td colSpan="8" className="px-6 py-12 text-center text-gray-500">No tickets found.</td></tr>
              ) : (
                tickets.map((ticket) => (
                  <tr key={ticket.id} className="hover:bg-gray-50 transition-colors group">
                    <td className="px-6 py-4 whitespace-nowrap w-20">
                      <div className="w-12 h-12 bg-gray-100 rounded-lg overflow-hidden border border-gray-200 cursor-zoom-in" onClick={() => setSelectedTicket(ticket)}>
                        {ticket.imageUrl ? (
                          <img 
                            src={ticket.imageUrl.startsWith('http') ? ticket.imageUrl : `http://localhost:4000${ticket.imageUrl}`} 
                            alt="Ticket thumb" 
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400">
                             <FileText className="w-5 h-5" />
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-0 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
                        {ticket.ticketNumber || 'No Ticket #'}
                        {ticket.source === 'WHATSAPP' ? <Smartphone className="w-3 h-3 text-green-500" /> : <Mail className="w-3 h-3 text-blue-500" />}
                      </div>
                      <div className="text-xs text-gray-500">{new Date(ticket.receivedAt).toLocaleDateString()}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {ticket.supplier?.name || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {ticket.material || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-medium">
                      {ticket.quantity ? `${ticket.quantity} ${ticket.unit || 'ton'}` : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {ticket.poNumber || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        ticket.status === 'LINKED' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                      }`}>
                        {ticket.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button 
                        onClick={() => setSelectedTicket(ticket)}
                        className="text-green-600 hover:text-green-900 bg-green-50 hover:bg-green-100 px-3 py-1.5 rounded-lg transition-colors inline-flex items-center gap-2"
                      >
                        <Eye className="w-4 h-4" /> Review
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail Modal */}
      {selectedTicket && (
        <div className="fixed inset-0 z-50 overflow-hidden" aria-labelledby="modal-title" role="dialog" aria-modal="true">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-gray-600 bg-opacity-75 transition-opacity backdrop-blur-sm" onClick={() => setSelectedTicket(null)}></div>

            <div className="inline-block align-bottom bg-white rounded-2xl text-left overflow-hidden shadow-2xl transform transition-all sm:my-8 sm:align-middle sm:max-w-6xl sm:w-full h-[90vh] flex flex-col">
              
              <div className="flex justify-between items-center px-6 py-4 border-b bg-gray-50">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-bold text-gray-900">
                    Ticket Review: {selectedTicket.ticketNumber || 'Unknown'}
                  </h3>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${selectedTicket.status === 'LINKED' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}`}>
                    {selectedTicket.status}
                  </span>
                  {selectedTicket.ocrConfidence > 0 && (
                    <div className="flex items-center gap-1 ml-4" title="OCR Confidence">
                       <div className="w-24 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                          <div 
                            className={`h-full ${selectedTicket.ocrConfidence > 0.8 ? 'bg-green-500' : selectedTicket.ocrConfidence > 0.5 ? 'bg-yellow-500' : 'bg-red-500'}`}
                            style={{ width: `${selectedTicket.ocrConfidence * 100}%` }}
                          ></div>
                       </div>
                       <span className="text-xs font-semibold text-gray-500">{Math.round(selectedTicket.ocrConfidence * 100)}%</span>
                    </div>
                  )}
                </div>
                <button onClick={() => setSelectedTicket(null)} className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded-full hover:bg-gray-100">
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="flex flex-1 overflow-hidden">
                {/* Image Side */}
                <div className="flex-[1.2] bg-gray-900 p-4 flex items-center justify-center overflow-hidden border-r relative group">
                  {selectedTicket.imageUrl ? (
                    <img 
                      src={selectedTicket.imageUrl.startsWith('http') ? selectedTicket.imageUrl : `http://localhost:4000${selectedTicket.imageUrl}`} 
                      className="max-w-full max-h-full object-contain shadow-2xl transition-transform duration-300 group-hover:scale-[1.02]"
                      alt="Full ticket"
                    />
                  ) : (
                    <div className="text-gray-500 flex flex-col items-center">
                       <FileText className="w-16 h-16 mb-2 opacity-20" />
                       No image available
                    </div>
                  )}
                </div>

                {/* Data & Linking Side */}
                <div className="flex-1 overflow-y-auto p-6 bg-white space-y-8">
                  
                  {/* OCR Data Section */}
                  <section>
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-sm font-bold text-gray-900 uppercase tracking-widest flex items-center gap-2">
                        <FileText className="w-4 h-4 text-green-600" /> Extracted Information
                      </h4>
                      <p className="text-[10px] text-gray-400 font-medium">VALUES CAN BE MANUALLY OVERRIDDEN</p>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-gray-500 uppercase px-1">Supplier</label>
                        <input 
                          type="text" 
                          className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none transition-all"
                          defaultValue={selectedTicket.supplier?.name}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { supplierName: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-gray-500 uppercase px-1">Ticket Date</label>
                        <input 
                          type="date" 
                          className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                          defaultValue={selectedTicket.ticketDate ? new Date(selectedTicket.ticketDate).toISOString().split('T')[0] : ''}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { ticketDate: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-gray-500 uppercase px-1">Ticket Number</label>
                        <input 
                          type="text" 
                          className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                          defaultValue={selectedTicket.ticketNumber}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { ticketNumber: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-gray-500 uppercase px-1">PO Number</label>
                        <input 
                          type="text" 
                          className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                          defaultValue={selectedTicket.poNumber}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { poNumber: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-gray-500 uppercase px-1">Material</label>
                        <input 
                          type="text" 
                          className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                          defaultValue={selectedTicket.material}
                          onBlur={(e) => handleUpdateTicket(selectedTicket.id, { material: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-gray-500 uppercase px-1">Quantity</label>
                        <div className="relative">
                          <input 
                            type="number" 
                            className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                            defaultValue={selectedTicket.quantity}
                            onBlur={(e) => handleUpdateTicket(selectedTicket.id, { quantity: parseFloat(e.target.value) })}
                          />
                        </div>
                      </div>
                    </div>
                  </section>

                  <hr className="border-gray-100" />

                  {/* Linking Section */}
                  <section className="bg-green-50/50 p-6 rounded-2xl border border-green-100">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-sm font-bold text-gray-900 uppercase tracking-widest flex items-center gap-2">
                        <LinkIcon className="w-4 h-4 text-green-600" /> Linked Order
                      </h4>
                    </div>

                    {selectedTicket.linkedOrder ? (
                      <div className="bg-white p-4 rounded-xl border border-green-200 flex items-center justify-between">
                         <div>
                            <p className="text-xs text-green-600 font-bold uppercase mb-1">Successfully Linked</p>
                            <p className="text-sm font-bold text-gray-900">Spruce ID: {selectedTicket.linkedOrder.spruceOrderId}</p>
                            <p className="text-xs text-gray-500">Method: {selectedTicket.linkMethod} Link</p>
                         </div>
                         <button 
                          onClick={() => handleUpdateTicket(selectedTicket.id, { linkedOrderId: null })}
                          className="text-xs text-red-600 hover:bg-red-50 px-3 py-2 rounded-lg font-bold border border-red-100 transition-colors"
                         >
                            Unlink
                         </button>
                      </div>
                    ) : (
                      <div className="space-y-4">
                         <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <input 
                              type="text" 
                              placeholder="Search Order by PO, Customer, ID..."
                              className="w-full pl-10 pr-4 py-3 bg-white border-2 border-green-100 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none shadow-sm"
                              value={orderSearch}
                              onChange={(e) => {
                                setOrderSearch(e.target.value);
                                searchOrders(e.target.value);
                              }}
                            />
                         </div>

                         <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                            {searchingOrders ? (
                              <div className="text-center py-4 text-gray-400 text-xs italic">Searching available orders...</div>
                            ) : orderResults.length > 0 ? (
                               orderResults.map(order => (
                                 <div key={order.id} className="bg-white p-3 rounded-xl border border-gray-100 flex items-center justify-between hover:border-green-300 transition-all shadow-sm group">
                                    <div className="flex-1">
                                       <p className="text-sm font-bold text-gray-900">{order.customerName}</p>
                                       <p className="text-[10px] text-gray-500 uppercase tracking-tighter">ID: {order.spruceOrderId} | PO: {order.poNumber || 'N/A'}</p>
                                    </div>
                                    <div className="flex items-center gap-3">
                                       <span className="text-xs font-bold text-gray-500">${Number(order.totalAmount || 0).toFixed(2)}</span>
                                       <button 
                                          onClick={() => handleLinkToOrder(selectedTicket.id, order.id)}
                                          className="bg-green-600 text-white p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                                       >
                                          <LinkIcon className="w-4 h-4" />
                                       </button>
                                    </div>
                                 </div>
                               ))
                            ) : orderSearch ? (
                               <div className="text-center py-4 text-gray-400 text-xs italic">No matching orders found</div>
                            ) : (
                               <div className="text-center py-4 text-gray-400 text-xs italic">Enter search criteria above</div>
                            )}
                         </div>
                      </div>
                    )}
                  </section>
                </div>
              </div>

            </div>
          </div>
        </div>
      )}

    </div>
  );
}
