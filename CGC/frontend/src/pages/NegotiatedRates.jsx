import React, { useState } from 'react';
import { Plus, Search, Edit2, Trash2, X, AlertCircle } from 'lucide-react';

const initialRates = [
  { id: 1, supplier: 'EcoGrow Farm Solutions', product: 'Premium Fertilizer', rate: '$45.00/bag', validUntil: '2026-12-31' },
  { id: 2, supplier: 'Green Valley Logistics', product: 'Freight Transport', rate: '$2.15/mile', validUntil: '2026-06-30' },
  { id: 3, supplier: 'Green Valley Logistics', product: 'Cold Storage', rate: '$150.00/month', validUntil: '2026-06-30' },
];

export default function NegotiatedRates() {
  const [rates, setRates] = useState(initialRates);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRate, setEditingRate] = useState(null);

  const [formData, setFormData] = useState({ supplier: '', product: '', rate: '', validUntil: '' });

  const handleOpenModal = (rate = null) => {
    if (rate) {
      setFormData(rate);
      setEditingRate(rate.id);
    } else {
      setFormData({ supplier: '', product: '', rate: '', validUntil: '' });
      setEditingRate(null);
    }
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingRate(null);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (editingRate) {
      setRates(rates.map(r => r.id === editingRate ? { ...formData, id: editingRate } : r));
    } else {
      setRates([...rates, { ...formData, id: Date.now() }]);
    }
    handleCloseModal();
  };

  const handleDelete = (id) => {
    if (window.confirm('Are you sure you want to delete this rate?')) {
      setRates(rates.filter(r => r.id !== id));
    }
  };

  const filteredRates = rates.filter(r => 
    r.supplier.toLowerCase().includes(searchTerm.toLowerCase()) || 
    r.product.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Negotiated Rates</h1>
          <p className="text-gray-500 mt-1">Manage special pricing agreements with your suppliers</p>
        </div>
        <button 
          onClick={() => handleOpenModal()} 
          className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-4 py-2.5 rounded-xl font-medium transition-all shadow-sm shadow-primary-500/30 hover:shadow-md hover:-translate-y-0.5"
        >
          <Plus className="w-5 h-5" />
          Add New Rate
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
          <div className="relative max-w-sm w-full">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="Search by supplier or product..."
              className="block w-full pl-10 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-colors"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-gray-600">
            <thead className="bg-gray-50 text-gray-700 uppercase text-xs font-semibold">
              <tr>
                <th className="px-6 py-4">Supplier</th>
                <th className="px-6 py-4">Product / Service</th>
                <th className="px-6 py-4">Negotiated Rate</th>
                <th className="px-6 py-4">Valid Until</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredRates.length === 0 ? (
                <tr>
                  <td colSpan="5" className="px-6 py-12 text-center text-gray-500">
                    <AlertCircle className="w-8 h-8 mx-auto mb-3 text-gray-400" />
                    No rates found matching your criteria.
                  </td>
                </tr>
              ) : (
                filteredRates.map((rate) => (
                  <tr key={rate.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-6 py-4 font-medium text-gray-900">{rate.supplier}</td>
                    <td className="px-6 py-4">{rate.product}</td>
                    <td className="px-6 py-4 font-mono font-medium text-primary-700 bg-primary-50/50 rounded-lg my-2 inline-block px-2 py-1 mt-3 ml-6">{rate.rate}</td>
                    <td className="px-6 py-4 text-gray-500">{rate.validUntil}</td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => handleOpenModal(rate)} className="p-2 text-primary-600 hover:bg-primary-50 rounded-lg transition-colors" title="Edit">
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button onClick={() => handleDelete(rate.id)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Delete">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={handleCloseModal}></div>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md relative z-10 overflow-hidden flex flex-col max-h-full">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h3 className="text-lg font-bold text-gray-900">
                {editingRate ? 'Edit Rate' : 'Add New Rate'}
              </h3>
              <button onClick={handleCloseModal} className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded-lg hover:bg-gray-100">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto">
              <form id="rateForm" onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Supplier Name</label>
                  <input required type="text" className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none transition-shadow" placeholder="e.g. Acme Farms" value={formData.supplier} onChange={e => setFormData({...formData, supplier: e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Product or Service</label>
                  <input required type="text" className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none transition-shadow" placeholder="e.g. Fertilizer X" value={formData.product} onChange={e => setFormData({...formData, product: e.target.value})} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Rate</label>
                    <input required type="text" className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none transition-shadow" placeholder="$10.00/unit" value={formData.rate} onChange={e => setFormData({...formData, rate: e.target.value})} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Valid Until</label>
                    <input required type="date" className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none transition-shadow" value={formData.validUntil} onChange={e => setFormData({...formData, validUntil: e.target.value})} />
                  </div>
                </div>
              </form>
            </div>
            
            <div className="p-6 border-t border-gray-100 bg-gray-50 flex justify-end gap-3 rounded-b-2xl">
              <button type="button" onClick={handleCloseModal} className="px-4 py-2 border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-100 transition-colors font-medium">
                Cancel
              </button>
              <button type="submit" form="rateForm" className="px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-700 transition-colors shadow-sm font-medium">
                {editingRate ? 'Save Changes' : 'Create Rate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
