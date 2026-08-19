import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api/axios';
import {
  Plus,
  Search,
  Edit2,
  Trash2,
  X,
  Check,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Skeleton } from '../../components/Skeleton';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '../../components/ui';
import { businessDayOf, formatDate } from '../../lib/date';

const INITIAL_FORM = {
  supplierId: '',
  productName: '',
  rate: '',
  unit: 'tonne',
  effectiveFrom: businessDayOf(),
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
      // Express, not the fetch-cgc-data Edge function. Measured on production,
      // the Edge hop cost 245-1020ms per resource against 117-123ms here, and
      // each Edge call went out twice — this page issued four requests for two
      // pieces of data and took ~1.4s to settle.
      const [resSuppliers, resProducts] = await Promise.all([
        api.get('/api/suppliers'),
        api.get('/api/products'),
      ]);

      const unwrap = (d) => (Array.isArray(d) ? d : d?.data || []);
      const suppliersData = unwrap(resSuppliers.data);
      const productsData = unwrap(resProducts.data);

      setSuppliers(suppliersData);
      setProducts(productsData);

      // Extract all rates from all suppliers
      const allRates = suppliersData.flatMap(s =>
        (s.negotiatedRates || []).map(r => ({ ...r, supplierName: s.name }))
      );
      setRates(allRates);
    } catch {
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
      const today = businessDayOf();
      await api.patch(`/api/suppliers/${rate.supplierId}/rates/${rate.id}`, { effectiveTo: today });
      toast.success('Rate deactivated');
      fetchData();
    } catch {
      toast.error('Failed to deactivate');
    }
  };

  const handleDelete = async (rate) => {
    if (!window.confirm(`Are you sure you want to delete the rate for "${rate.productName}"?`)) return;
    try {
      await api.delete(`/api/suppliers/${rate.supplierId}/rates/${rate.id}`);
      toast.success('Rate deleted');
      fetchData();
    } catch {
      toast.error('Failed to delete rate');
    }
  };

  const filteredRates = rates.filter(r =>
    r.productName.toLowerCase().includes(search.toLowerCase()) ||
    r.supplierName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full space-y-6">
      <PageHeader
        title="Negotiated rates"
        subtitle="The agreed prices used when an invoice line is checked."
        actions={
          <Button variant="primary" onClick={() => handleOpenModal()}>
            <Plus className="w-4 h-4" /> Add rate
          </Button>
        }
      />

      <div className="flex flex-wrap gap-4 items-center">
        <div className="relative flex-1 min-w-[300px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <Input
            type="text"
            placeholder="Search products or suppliers..."
            className="pl-10"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="bg-surface px-3 py-1.5 rounded-pill border border-line text-[13px] font-semibold text-muted flex items-center gap-2">
          <Check className="w-3 h-3 text-brand" />
          <span className="tabular">{filteredRates.length}</span> rates
        </div>
      </div>

      <Card className="flex-1 overflow-hidden flex flex-col">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line">
            <thead className="bg-ink/[0.03] sticky top-0">
              <tr>
                <th className="px-6 py-3 text-left text-[12.5px] font-semibold text-muted">Supplier</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-semibold text-muted">Product</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-semibold text-muted">Rate</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-semibold text-muted">Unit</th>
                <th className="px-6 py-3 text-left text-[12.5px] font-semibold text-muted">Validity</th>
                <th className="px-6 py-3 text-right text-[12.5px] font-semibold text-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-surface divide-y divide-line">
              {loading ? (
                <RatesTableSkeleton />
              ) : filteredRates.length === 0 ? (
                <tr>
                  <td colSpan="6">
                    <EmptyState
                      title="No rates match"
                      message="Try another search, or add a negotiated rate for a supplier."
                    />
                  </td>
                </tr>
              ) : (
                filteredRates.map((rate) => {
                  const isActive = !rate.effectiveTo || new Date(rate.effectiveTo) >= new Date();
                  return (
                    <tr key={rate.id} className="hover:bg-brand/[0.04] transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-ink">{rate.supplierName}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-muted">{rate.productName}</td>
                      <td className="tabular px-6 py-4 whitespace-nowrap text-sm font-bold text-ink">${Number(rate.rate).toFixed(2)}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-muted">{rate.unit}</td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="tabular text-[13px] text-ink">
                          {formatDate(rate.effectiveFrom)} to {rate.effectiveTo ? formatDate(rate.effectiveTo) : 'Present'}
                        </div>
                        {!isActive && <Badge tone="bad" className="mt-1">Expired</Badge>}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                        <button onClick={() => handleOpenModal(rate)} className="text-muted hover:text-ink transition-colors p-1" title="Edit"><Edit2 className="w-4 h-4" /></button>
                        {isActive && (
                          <button onClick={() => handleDeactivate(rate)} className="text-muted hover:text-ochre transition-colors p-1" title="Deactivate"><X className="w-4 h-4" /></button>
                        )}
                        <button onClick={() => handleDelete(rate)} className="text-muted hover:text-clay transition-colors p-1" title="Delete"><Trash2 className="w-4 h-4" /></button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim/50 backdrop-blur-sm transition-all">
          <div className="bg-surface rounded-card shadow-lift border border-line w-full max-w-lg overflow-hidden animate-in fade-in zoom-in duration-150">
            <div className="px-6 py-4 border-b border-line flex justify-between items-center">
              <h3 className="text-lg font-bold text-ink">{editingRate ? 'Edit negotiated rate' : 'Add negotiated rate'}</h3>
              <button onClick={handleCloseModal} className="text-muted hover:text-ink"><X className="w-5 h-5" /></button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <Field label="Supplier" htmlFor="rate-supplier">
                <Select
                  id="rate-supplier"
                  value={formData.supplierId}
                  onChange={e => setFormData({...formData, supplierId: e.target.value})}
                  disabled={!!editingRate}
                >
                  <option value="">Select supplier</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>

              <Field label="Product" htmlFor="rate-product">
                <Select
                  id="rate-product"
                  value={formData.productName}
                  onChange={e => setFormData({...formData, productName: e.target.value})}
                >
                  <option value="">Select product</option>
                  {products.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                  <option value="CUSTOM">+ Add custom item...</option>
                </Select>
              </Field>
              {formData.productName === 'CUSTOM' && (
                <Input
                  type="text"
                  placeholder="Enter custom product name..."
                  onChange={e => setFormData({...formData, productName: e.target.value})}
                />
              )}

              <div className="grid grid-cols-2 gap-4">
                <Field label="Rate ($)" htmlFor="rate-value">
                  <Input
                    id="rate-value"
                    type="number"
                    step="0.001"
                    className="tabular"
                    placeholder="0.00"
                    value={formData.rate}
                    onChange={e => setFormData({...formData, rate: e.target.value})}
                  />
                </Field>
                <Field label="Unit" htmlFor="rate-unit">
                  <Input
                    id="rate-unit"
                    type="text"
                    placeholder="tonne, load, etc"
                    value={formData.unit}
                    onChange={e => setFormData({...formData, unit: e.target.value})}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field label="Effective from" htmlFor="rate-from">
                  <Input
                    id="rate-from"
                    type="date"
                    className="tabular"
                    value={formData.effectiveFrom}
                    max={formData.effectiveTo || undefined}
                    onChange={e => setFormData({...formData, effectiveFrom: e.target.value})}
                  />
                </Field>
                <Field label="Effective to" htmlFor="rate-to">
                  <Input
                    id="rate-to"
                    type="date"
                    className="tabular"
                    value={formData.effectiveTo}
                    min={formData.effectiveFrom || undefined}
                    onChange={e => setFormData({...formData, effectiveTo: e.target.value})}
                  />
                </Field>
              </div>

              <Field label="Notes" htmlFor="rate-notes">
                <Textarea
                  id="rate-notes"
                  placeholder="Enter any notes..."
                  value={formData.notes}
                  onChange={e => setFormData({...formData, notes: e.target.value})}
                />
              </Field>

              <div className="pt-4 flex gap-3">
                <Button type="button" onClick={handleCloseModal} className="flex-1">
                  Cancel
                </Button>
                <Button type="submit" variant="primary" className="flex-1">
                  {editingRate ? 'Update rate' : 'Create rate'}
                </Button>
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
              <Skeleton variant="rectangle" width="24px" height="24px" className="rounded-control" />
              <Skeleton variant="rectangle" width="24px" height="24px" className="rounded-control" />
              <Skeleton variant="rectangle" width="24px" height="24px" className="rounded-control" />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}
