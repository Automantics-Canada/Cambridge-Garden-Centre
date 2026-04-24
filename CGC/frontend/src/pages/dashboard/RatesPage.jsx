import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api/axios';
import { 
  Plus, 
  Search, 
  Edit2, 
  Trash2, 
  PlusCircle, 
  History,
  X,
  Check,
  AlertCircle
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Skeleton } from '../../components/Skeleton';
import Loader from '../../components/Loader';

const INITIAL_FORM = {
  supplierId: '',
  productName: '',
  rate: '',
  unit: 'tonne',
  effectiveFrom: new Date().toISOString().split('T')[0],
  effectiveTo: '',
  notes: ''
};

export default function RatesPage() {
  const [rates, setRates] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRate, setEditingRate] = useState(null);
  const [formData, setFormData] = useState(INITIAL_FORM);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [resSuppliers, resProducts] = await Promise.all([
        api.get('/api/suppliers'),
        api.get('/api/products')
      ]);
      setSuppliers(resSuppliers.data);
      setProducts(resProducts.data);
      
      // Extract all rates from all suppliers
      const allRates = resSuppliers.data.flatMap(s => 
        (s.negotiatedRates || []).map(r => ({ ...r, supplierName: s.name }))
      );
      setRates(allRates);
    } catch (err) {
      toast.error('Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleOpenModal = (rate = null) => {
    if (rate) {
      setEditingRate(rate);
      setFormData({
        supplierId: rate.supplierId,
        productName: rate.productName,
        rate: Number(rate.rate),
        unit: rate.unit,
        effectiveFrom: rate.effectiveFrom.split('T')[0],
        effectiveTo: rate.effectiveTo ? rate.effectiveTo.split('T')[0] : '',
        notes: rate.notes || ''
      });
    } else {
      setEditingRate(null);
      setFormData(INITIAL_FORM);
    }
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingRate(null);
    setFormData(INITIAL_FORM);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.supplierId || !formData.productName || !formData.rate) {
      toast.error('Please fill required fields');
      return;
    }

    try {
      if (editingRate) {
        await api.patch(`/api/suppliers/${formData.supplierId}/rates/${editingRate.id}`, formData);
        toast.success('Rate updated successfully');
      } else {
        await api.post(`/api/suppliers/${formData.supplierId}/rates`, formData);
        toast.success('New rate added successfully');
      }
      fetchData();
      handleCloseModal();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save rate');
    }
  };

  const handleDeactivate = async (rate) => {
    if (!window.confirm(`Deactivate rate for "${rate.productName}"? This sets the expiration to today.`)) return;
    try {
      const today = new Date().toISOString().split('T')[0];
      await api.patch(`/api/suppliers/${rate.supplierId}/rates/${rate.id}`, { effectiveTo: today });
      toast.success('Rate deactivated');
      fetchData();
    } catch (err) {
      toast.error('Failed to deactivate');
    }
  };

  const handleDelete = async (rate) => {
    if (!window.confirm(`Are you sure you want to delete the rate for "${rate.productName}"?`)) return;
    try {
      await api.delete(`/api/suppliers/${rate.supplierId}/rates/${rate.id}`);
      toast.success('Rate deleted');
      fetchData();
    } catch (err) {
      toast.error('Failed to delete rate');
    }
  };

  const filteredRates = rates.filter(r => 
    r.productName.toLowerCase().includes(search.toLowerCase()) ||
    r.supplierName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full space-y-4">
      <div className="sm:flex sm:items-center justify-between bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
        <div className="sm:flex-auto">
          <h1 className="text-2xl font-semibold text-gray-900">Negotiated Rates</h1>
          <p className="mt-2 text-sm text-gray-700">
            Manage contract pricing for suppliers and trucking companies.
          </p>
        </div>
        <div className="mt-4 sm:ml-16 sm:mt-0 sm:flex-none">
          <button
            onClick={() => handleOpenModal()}
            className="flex items-center gap-2 bg-gray-900 hover:bg-black text-white px-4 py-2 rounded-lg font-medium text-sm transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" /> Add New Rate
          </button>
        </div>
      </div>

      {/* Search & Stats */}
      <div className="flex flex-wrap gap-4 items-center">
        <div className="relative flex-1 min-w-[300px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input 
            type="text" 
            placeholder="Search products or suppliers..."
            className="w-full pl-10 pr-4 py-2 border rounded-xl focus:ring-2 focus:ring-gray-100 outline-none text-sm transition-all"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
           <div className="bg-white px-3 py-1.5 rounded-lg border text-xs font-semibold text-gray-500 shadow-xs flex items-center gap-2">
             <Check className="w-3 h-3 text-green-500" /> {rates.length} ACTIVE RATES
           </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Supplier</th>
                <th className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Product</th>
                <th className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Rate</th>
                <th className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Unit</th>
                <th className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Validity</th>
                <th className="px-6 py-3 text-right text-xs font-bold text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <RatesTableSkeleton />
              ) : filteredRates.length === 0 ? (
                <tr><td colSpan="6" className="px-6 py-12 text-center text-gray-500">No rates found matching search.</td></tr>
              ) : (
                filteredRates.map((rate) => {
                  const isActive = !rate.effectiveTo || new Date(rate.effectiveTo) >= new Date();
                  return (
                    <tr key={rate.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{rate.supplierName}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{rate.productName}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-green-700">${Number(rate.rate).toFixed(2)}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 uppercase">{rate.unit}</td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-xs text-gray-900">{new Date(rate.effectiveFrom).toLocaleDateString()} to {rate.effectiveTo ? new Date(rate.effectiveTo).toLocaleDateString() : 'Present'}</div>
                        {!isActive && <span className="text-[10px] text-red-500 font-bold uppercase italic">Expired</span>}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                        <button onClick={() => handleOpenModal(rate)} className="text-gray-400 hover:text-gray-900 transition-colors p-1" title="Edit"><Edit2 className="w-4 h-4" /></button>
                        {isActive && (
                          <button onClick={() => handleDeactivate(rate)} className="text-gray-400 hover:text-orange-600 transition-colors p-1" title="Deactivate"><X className="w-4 h-4" /></button>
                        )}
                        <button onClick={() => handleDelete(rate)} className="text-gray-400 hover:text-red-600 transition-colors p-1" title="Delete"><Trash2 className="w-4 h-4" /></button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal Form */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm transition-all">
          <div className="bg-white rounded-2xl shadow-2xl border w-full max-w-lg overflow-hidden animate-in fade-in zoom-in duration-150">
            <div className="bg-gray-50 px-6 py-4 border-b flex justify-between items-center">
              <h3 className="text-lg font-bold text-gray-900">{editingRate ? 'Edit Negotiated Rate' : 'Add Negotiated Rate'}</h3>
              <button onClick={handleCloseModal} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>
            
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Supplier *</label>
                  <select 
                    className="w-full border rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-gray-100 border-gray-200 transition-all"
                    value={formData.supplierId}
                    onChange={e => setFormData({...formData, supplierId: e.target.value})}
                    disabled={!!editingRate}
                  >
                    <option value="">Select Supplier</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Product Name *</label>
                  <select 
                    className="w-full border rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-gray-100 border-gray-200 transition-all bg-white"
                    value={formData.productName}
                    onChange={e => setFormData({...formData, productName: e.target.value})}
                  >
                    <option value="">Select Product</option>
                    {products.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                    <option value="CUSTOM">+ Add Custom Item...</option>
                  </select>
                  {formData.productName === 'CUSTOM' && (
                    <input 
                      type="text"
                      className="mt-2 w-full border rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-gray-100 border-gray-200 transition-all"
                      placeholder="Enter custom product name..."
                      onChange={e => setFormData({...formData, productName: e.target.value})}
                    />
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Rate ($) *</label>
                    <input 
                      type="number" 
                      step="0.001"
                      className="w-full border rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-gray-100 border-gray-200 transition-all"
                      placeholder="0.00"
                      value={formData.rate}
                      onChange={e => setFormData({...formData, rate: e.target.value})}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Unit *</label>
                    <input 
                      type="text" 
                      className="w-full border rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-gray-100 border-gray-200 transition-all text-gray-400 font-bold uppercase"
                      placeholder="tonne, load, etc"
                      value={formData.unit}
                      onChange={e => setFormData({...formData, unit: e.target.value})}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Effective From *</label>
                    <input 
                      type="date" 
                      className="w-full border rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-gray-100 border-gray-200 transition-all"
                      value={formData.effectiveFrom}
                      onChange={e => setFormData({...formData, effectiveFrom: e.target.value})}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Effective To</label>
                    <input 
                      type="date" 
                      className="w-full border rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-gray-100 border-gray-200 transition-all"
                      value={formData.effectiveTo}
                      onChange={e => setFormData({...formData, effectiveTo: e.target.value})}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Notes</label>
                  <textarea 
                    className="w-full border rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-gray-100 border-gray-200 transition-all h-20"
                    placeholder="Enter any notes..."
                    value={formData.notes}
                    onChange={e => setFormData({...formData, notes: e.target.value})}
                  />
                </div>
              </div>

              <div className="pt-4 flex gap-3">
                <button 
                  type="button" 
                  onClick={handleCloseModal}
                  className="flex-1 py-2.5 text-sm font-bold text-gray-500 hover:bg-gray-100 rounded-xl transition-all"
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  className="flex-1 py-2.5 text-sm font-bold text-white bg-gray-900 hover:bg-black rounded-xl transition-all shadow-lg"
                >
                  {editingRate ? 'Update Rate' : 'Create Rate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
function RatesTableSkeleton() {
  return (
    <>
      {[...Array(10)].map((_, i) => (
        <tr key={i}>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="text" width="140px" height="16px" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="text" width="120px" height="16px" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="text" width="60px" height="16px" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="text" width="50px" height="16px" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <Skeleton variant="text" width="100px" height="16px" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap text-right space-x-2">
            <div className="flex justify-end gap-2">
              <Skeleton variant="rectangle" width="24px" height="24px" className="rounded-md" />
              <Skeleton variant="rectangle" width="24px" height="24px" className="rounded-md" />
              <Skeleton variant="rectangle" width="24px" height="24px" className="rounded-md" />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}
