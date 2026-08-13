import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { Plus, Edit, Trash2, AlertCircle, ChevronDown, Check, FileText, PlusCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { fetchSuppliers, deleteSupplier, deleteSupplierRate, clearSuccess, clearError } from '../../store/supplierSlice';
import Modal from '../../components/Modal';
import SupplierForm from '../../components/SupplierForm';
import RateForm from '../../components/RateForm';
import { Skeleton } from '../../components/Skeleton';
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
import { formatDate } from '../../lib/date';

const formatTypeLabel = (str) => {
  if (!str) return '';
  return str.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
};

export default function SupplierPage() {
  const dispatch = useDispatch();
  const { suppliers, loading, error, success, successMessage } = useSelector((state) => state.suppliers);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isRateModalOpen, setIsRateModalOpen] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState(null);
  const [rateModalSupplierId, setRateModalSupplierId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [expandedSupplierId, setExpandedSupplierId] = useState(null);
  const [selectedRate, setSelectedRate] = useState(null);
  const [rateDeleteConfirm, setRateDeleteConfirm] = useState(null);

  useEffect(() => {
    dispatch(fetchSuppliers());
  }, [dispatch]);

  useEffect(() => {
    if (success) {
      toast.success(successMessage);
      dispatch(clearSuccess());
    }
  }, [success, successMessage, dispatch]);

  useEffect(() => {
    if (error) {
      toast.error(error);
      dispatch(clearError());
    }
  }, [error, dispatch]);

  const handleCreateNew = () => {
    setSelectedSupplier(null);
    setIsModalOpen(true);
  };

  const handleEdit = (supplier) => {
    setSelectedSupplier(supplier);
    setIsModalOpen(true);
  };

  const handleDelete = (supplier) => {
    setDeleteConfirm(supplier);
  };

  const confirmDelete = async () => {
    if (deleteConfirm) {
      try {
        await dispatch(deleteSupplier(deleteConfirm.id)).unwrap();
      } catch (err) {
        toast.error(err || 'Failed to delete supplier');
      }
      setDeleteConfirm(null);
    }
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedSupplier(null);
  };

  const handleOpenRateModal = (supplierId) => {
    setRateModalSupplierId(supplierId);
    setIsRateModalOpen(true);
  };

  const handleCloseRateModal = () => {
    setIsRateModalOpen(false);
    setRateModalSupplierId(null);
    setSelectedRate(null);
  };

  const filteredSuppliers = suppliers.filter(supplier => {
    const matchesSearch = supplier.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = !filterType || supplier.type === filterType;
    return matchesSearch && matchesType;
  });

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
      },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 },
  };

  const supplierTypes = ['SUPPLIER', 'TRUCKING_COMPANY'];

  return (
    <Motion.div
      className="max-w-7xl mx-auto space-y-6"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <Motion.div variants={itemVariants}>
        <PageHeader
          title="Suppliers"
          subtitle="Who you buy from, and the rates you agreed with them."
          actions={
            <Button variant="primary" onClick={handleCreateNew}>
              <Plus size={20} />
              Add supplier
            </Button>
          }
        />
      </Motion.div>

      <Motion.div variants={itemVariants}>
        <Card className="p-4 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
          <div className="flex flex-col sm:flex-row gap-3 flex-1 w-full sm:w-auto">
            <Input
              type="text"
              placeholder="Search suppliers..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full sm:flex-1"
            />
            <Select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
            >
              <option value="">All types</option>
              {supplierTypes.map(type => (
                <option key={type} value={type}>{formatTypeLabel(type)}</option>
              ))}
            </Select>
          </div>
        </Card>
      </Motion.div>

      <Motion.div variants={itemVariants}>
        <Card className="overflow-hidden">
          {loading ? (
            <SupplierTableSkeleton />
          ) : filteredSuppliers.length === 0 ? (
            <EmptyState
              icon={AlertCircle}
              title="No suppliers found"
              message={suppliers.length === 0 ? 'Add the first supplier so invoices and tickets can be matched.' : 'Try a different search or type filter.'}
              action={suppliers.length === 0 ? (
                <Button variant="primary" onClick={handleCreateNew}>
                  <Plus size={20} />
                  Add first supplier
                </Button>
              ) : undefined}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-ink/[0.03] border-b border-line">
                    <th className="px-6 py-4 font-semibold text-muted w-10"></th>
                    <th className="text-left px-6 py-4 font-semibold text-muted">Name</th>
                    <th className="text-left px-6 py-4 font-semibold text-muted">Type</th>
                    <th className="text-left px-6 py-4 font-semibold text-muted">Contact</th>
                    <th className="text-left px-6 py-4 font-semibold text-muted">Email</th>
                    <th className="text-left px-6 py-4 font-semibold text-muted">Rates</th>
                    <th className="text-right px-6 py-4 font-semibold text-muted">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSuppliers.map((supplier, index) => (
                    <React.Fragment key={supplier.id}>
                      <Motion.tr
                        key={supplier.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                        className={cn(
                          'border-b border-line hover:bg-brand/[0.04] transition-colors cursor-pointer',
                          expandedSupplierId === supplier.id && 'bg-brand/[0.04]'
                        )}
                        onClick={() => setExpandedSupplierId(expandedSupplierId === supplier.id ? null : supplier.id)}
                      >
                        <td className="px-6 py-4">
                          <ChevronDown
                            size={18}
                            className={cn(
                              'text-muted transition-transform',
                              expandedSupplierId === supplier.id && 'rotate-180 text-brand'
                            )}
                          />
                        </td>
                        <td className="px-6 py-4">
                          <p className="font-medium text-ink">{supplier.name}</p>
                        </td>
                        <td className="px-6 py-4">
                          <Badge tone="neutral">{formatTypeLabel(supplier.type)}</Badge>
                        </td>
                        <td className="px-6 py-4">
                          <p className="text-ink">{supplier.contactName || '-'}</p>
                        </td>
                        <td className="px-6 py-4">
                          <p className="text-muted text-sm">{supplier.contactEmail || '-'}</p>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-1 text-[13px] font-semibold text-brand">
                            <Check size={12} /> {supplier.negotiatedRates?.length || 0} products
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex justify-end gap-3">
                            <Motion.button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleEdit(supplier);
                              }}
                              whileHover={{ scale: 1.1 }}
                              whileTap={{ scale: 0.9 }}
                              className="p-2 text-brand hover:bg-brand/10 rounded-control transition-colors"
                              title="Edit Basic Info"
                            >
                              <Edit size={18} />
                            </Motion.button>
                            <Motion.button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDelete(supplier);
                              }}
                              whileHover={{ scale: 1.1 }}
                              whileTap={{ scale: 0.9 }}
                              className="p-2 text-clay hover:bg-clay/10 rounded-control transition-colors"
                              title="Delete Supplier"
                            >
                              <Trash2 size={18} />
                            </Motion.button>
                          </div>
                        </td>
                      </Motion.tr>

                      <AnimatePresence>
                        {expandedSupplierId === supplier.id && (
                          <Motion.tr
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="bg-ink/[0.02]"
                          >
                            <td colSpan="7" className="px-6 py-0 overflow-hidden">
                              <div className="py-4 border-l-4 border-brand ml-2 pl-4 mb-4">
                                <div className="flex items-center justify-between mb-3">
                                  <h4 className="text-[13px] font-semibold text-muted flex items-center gap-2">
                                    <FileText size={14} className="text-brand" /> Negotiated rates and products
                                  </h4>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleOpenRateModal(supplier.id);
                                    }}
                                  >
                                    <PlusCircle size={14} /> Add rate
                                  </Button>
                                </div>

                                {supplier.negotiatedRates && supplier.negotiatedRates.length > 0 ? (
                                  <div className="space-y-2">
                                    {supplier.negotiatedRates.map((rate) => (
                                      <div key={rate.id} className="bg-surface border border-line rounded-control p-3 flex justify-between items-center group hover:shadow-lift transition-shadow">
                                        <div>
                                          <p className="text-sm font-semibold text-ink">{rate.productName}</p>
                                          <p className="tabular text-[12.5px] text-muted">{rate.unit} · Effective {formatDate(rate.effectiveFrom)}</p>
                                        </div>
                                        <div className="flex items-center gap-4">
                                          <div className="text-right">
                                            <p className="tabular text-sm font-bold text-ink font-mono">${Number(rate.rate).toFixed(2)}</p>
                                          </div>
                                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setSelectedRate(rate);
                                                setRateModalSupplierId(supplier.id);
                                                setIsRateModalOpen(true);
                                              }}
                                              className="p-1.5 text-brand hover:bg-brand/10 rounded-control transition-colors"
                                              title="Edit Rate"
                                            >
                                              <Edit size={14} />
                                            </button>
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setRateDeleteConfirm({ supplierId: supplier.id, rateId: rate.id, productName: rate.productName });
                                              }}
                                              className="p-1.5 text-clay hover:bg-clay/10 rounded-control transition-colors"
                                              title="Delete Rate"
                                            >
                                              <Trash2 size={14} />
                                            </button>
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-sm text-muted">No negotiated rates defined for this supplier.</p>
                                )}
                              </div>
                            </td>
                          </Motion.tr>
                        )}
                      </AnimatePresence>
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Motion.div>

      <Modal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        title={selectedSupplier ? 'Edit supplier' : 'Add supplier'}
      >
        <SupplierForm supplier={selectedSupplier} onClose={handleCloseModal} />
      </Modal>

      <Modal
        isOpen={isRateModalOpen}
        onClose={handleCloseRateModal}
        title={selectedRate ? 'Edit negotiated rate' : 'Add negotiated rate'}
      >
        <RateForm
          supplierId={rateModalSupplierId}
          rate={selectedRate}
          onClose={handleCloseRateModal}
        />
      </Modal>

      <AnimatePresence>
        {deleteConfirm && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
            <Motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-surface rounded-card shadow-lift max-w-sm w-full mx-4 p-6 border border-line"
            >
              <div className="flex gap-4 mb-4">
                <div className="w-12 h-12 bg-clay/14 rounded-pill flex items-center justify-center flex-shrink-0">
                  <AlertCircle className="w-6 h-6 text-clay" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-ink">Delete supplier?</h3>
                  <p className="text-muted text-sm mt-1">
                    Are you sure you want to delete <span className="font-semibold text-ink">{deleteConfirm.name}</span>? This action cannot be undone.
                  </p>
                </div>
              </div>
              <div className="flex gap-3 pt-4">
                <Button onClick={() => setDeleteConfirm(null)} className="flex-1">
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onClick={confirmDelete}
                  disabled={loading}
                  className="flex-1"
                >
                  {loading && (
                    <div className="w-4 h-4 border-2 border-on-clay border-t-transparent rounded-pill animate-spin" />
                  )}
                  Delete
                </Button>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {rateDeleteConfirm && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
            <Motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-surface rounded-card shadow-lift max-w-sm w-full mx-4 p-6 border border-line"
            >
              <div className="flex gap-4 mb-4">
                <div className="w-12 h-12 bg-clay/14 rounded-pill flex items-center justify-center flex-shrink-0">
                  <AlertCircle className="w-6 h-6 text-clay" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-ink">Delete rate?</h3>
                  <p className="text-muted text-sm mt-1">
                    Are you sure you want to delete the rate for <span className="font-semibold text-ink">{rateDeleteConfirm.productName}</span>?
                  </p>
                </div>
              </div>
              <div className="flex gap-3 pt-4">
                <Button onClick={() => setRateDeleteConfirm(null)} className="flex-1">
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onClick={async () => {
                    await dispatch(deleteSupplierRate({ supplierId: rateDeleteConfirm.supplierId, rateId: rateDeleteConfirm.rateId })).unwrap();
                    setRateDeleteConfirm(null);
                    toast.success('Rate deleted successfully');
                  }}
                  disabled={loading}
                  className="flex-1"
                >
                  {loading && (
                    <div className="w-4 h-4 border-2 border-on-clay border-t-transparent rounded-pill animate-spin" />
                  )}
                  Delete
                </Button>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>
    </Motion.div>
  );
}
function SupplierTableSkeleton() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="bg-ink/[0.03] border-b border-line">
            <th className="px-6 py-4 w-10"></th>
            <th className="text-left px-6 py-4 font-semibold text-muted">Name</th>
            <th className="text-left px-6 py-4 font-semibold text-muted">Type</th>
            <th className="text-left px-6 py-4 font-semibold text-muted">Contact</th>
            <th className="text-left px-6 py-4 font-semibold text-muted">Email</th>
            <th className="text-left px-6 py-4 font-semibold text-muted">Rates</th>
            <th className="text-right px-6 py-4 font-semibold text-muted">Actions</th>
          </tr>
        </thead>
        <tbody>
          {[...Array(8)].map((_, i) => (
            <tr key={i} className="border-b border-line">
              <td className="px-6 py-4">
                <Skeleton variant="rectangle" width="18px" height="18px" className="rounded" />
              </td>
              <td className="px-6 py-4">
                <Skeleton variant="text" width="150px" height="16px" />
              </td>
              <td className="px-6 py-4">
                <Skeleton variant="rectangle" width="80px" height="20px" className="rounded-pill" />
              </td>
              <td className="px-6 py-4">
                <Skeleton variant="text" width="120px" height="16px" />
              </td>
              <td className="px-6 py-4">
                <Skeleton variant="text" width="180px" height="16px" />
              </td>
              <td className="px-6 py-4">
                <Skeleton variant="text" width="60px" height="16px" />
              </td>
              <td className="px-6 py-4">
                <div className="flex justify-end gap-3">
                  <Skeleton variant="rectangle" width="34px" height="34px" className="rounded-control" />
                  <Skeleton variant="rectangle" width="34px" height="34px" className="rounded-control" />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
