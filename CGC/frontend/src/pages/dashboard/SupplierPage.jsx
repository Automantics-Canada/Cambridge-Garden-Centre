import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { Plus, Edit, Trash2, AlertCircle, ChevronDown, Check, FileText, PlusCircle } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { fetchSuppliers, deleteSupplier, clearSuccess, clearError } from '../../store/supplierSlice';
import Modal from '../../components/Modal';
import SupplierForm from '../../components/SupplierForm';
import RateForm from '../../components/RateForm';
import Loader from '../../components/Loader';

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
      {/* Header */}
      <Motion.div variants={itemVariants}>
        <h1 className="text-4xl font-bold text-gray-900 mb-2">Suppliers</h1>
        <p className="text-gray-600">Manage your supplier database</p>
      </Motion.div>

      {/* Action Bar */}
      <Motion.div
        variants={itemVariants}
        className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between"
      >
        <div className="flex flex-col sm:flex-row gap-3 flex-1 w-full sm:w-auto">
          {/* Search */}
          <input
            type="text"
            placeholder="Search suppliers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none w-full sm:flex-1"
          />

          {/* Filter by Type */}
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
          >
            <option value="">All Types</option>
            {supplierTypes.map(type => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </div>

        {/* Add New Button */}
        <Motion.button
          onClick={handleCreateNew}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors flex items-center gap-2 whitespace-nowrap"
        >
          <Plus size={20} />
          Add Supplier
        </Motion.button>
      </Motion.div>

      {/* Suppliers Table or Empty State */}
      <Motion.div
        variants={itemVariants}
        className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
      >
        {loading ? (
          <Loader message="Loading suppliers..." />
        ) : filteredSuppliers.length === 0 ? (
          <div className="p-12 text-center">
            <AlertCircle className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No suppliers found</h3>
            <p className="text-gray-600 mb-6">
              {suppliers.length === 0 ? 'Get started by adding your first supplier.' : 'Try adjusting your search filters.'}
            </p>
            {suppliers.length === 0 && (
              <button
                onClick={handleCreateNew}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors inline-flex items-center gap-2"
              >
                <Plus size={20} />
                Add First Supplier
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-6 py-4 font-semibold text-gray-900 w-10"></th>
                  <th className="text-left px-6 py-4 font-semibold text-gray-900">Name</th>
                  <th className="text-left px-6 py-4 font-semibold text-gray-900">Type</th>
                  <th className="text-left px-6 py-4 font-semibold text-gray-900">Contact</th>
                  <th className="text-left px-6 py-4 font-semibold text-gray-900">Email</th>
                  <th className="text-left px-6 py-4 font-semibold text-gray-900">Rates</th>
                  <th className="text-right px-6 py-4 font-semibold text-gray-900">Actions</th>
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
                      className={clsx(
                        "border-b border-gray-200 hover:bg-gray-50 transition-colors cursor-pointer",
                        expandedSupplierId === supplier.id && "bg-green-50/30"
                      )}
                      onClick={() => setExpandedSupplierId(expandedSupplierId === supplier.id ? null : supplier.id)}
                    >
                      <td className="px-6 py-4">
                        <ChevronDown 
                          size={18} 
                          className={clsx(
                            "text-gray-400 transition-transform",
                            expandedSupplierId === supplier.id && "rotate-180 text-green-600"
                          )} 
                        />
                      </td>
                      <td className="px-6 py-4">
                        <p className="font-medium text-gray-900">{supplier.name}</p>
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-block px-3 py-1 bg-blue-100 text-blue-800 text-xs font-medium rounded-full">
                          {supplier.type}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <p className="text-gray-700">{supplier.contactName || '-'}</p>
                      </td>
                      <td className="px-6 py-4">
                        <p className="text-gray-600 text-sm">{supplier.contactEmail || '-'}</p>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1 text-xs font-bold text-green-700">
                          <Check size={12} /> {supplier.negotiatedRates?.length || 0} Products
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
                            className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors border border-transparent hover:border-blue-100"
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
                            className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors border border-transparent hover:border-red-100"
                            title="Delete Supplier"
                          >
                            <Trash2 size={18} />
                          </Motion.button>
                        </div>
                      </td>
                    </Motion.tr>

                    {/* Expanded Rates Section */}
                    <AnimatePresence>
                      {expandedSupplierId === supplier.id && (
                        <Motion.tr
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="bg-gray-50/50"
                        >
                          <td colSpan="7" className="px-6 py-0 overflow-hidden">
                            <div className="py-4 border-l-4 border-green-500 ml-2 pl-4 mb-4">
                              <div className="flex items-center justify-between mb-3">
                                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                                  <FileText size={14} className="text-green-600" /> Negotiated Rates & Products
                                </h4>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleOpenRateModal(supplier.id);
                                  }}
                                  className="flex items-center gap-1.5 text-[10px] font-bold text-green-600 hover:text-green-700 bg-green-50 hover:bg-green-100 px-2 py-1 rounded-md transition-all border border-green-100"
                                >
                                  <PlusCircle size={14} /> Add Rate
                                </button>
                              </div>
                              
                              {supplier.negotiatedRates && supplier.negotiatedRates.length > 0 ? (
                                <div className="space-y-2">
                                  {supplier.negotiatedRates.map((rate) => (
                                    <div key={rate.id} className="bg-white border rounded-lg p-3 shadow-xs flex justify-between items-center group hover:shadow-md transition-shadow">
                                      <div>
                                        <p className="text-sm font-bold text-gray-900">{rate.productName}</p>
                                        <p className="text-[10px] text-gray-500 uppercase">{rate.unit} • Effective {new Date(rate.effectiveFrom).toLocaleDateString()}</p>
                                      </div>
                                      <div className="flex items-center gap-4">
                                        <div className="text-right">
                                          <p className="text-sm font-black text-green-700 font-mono">${Number(rate.rate).toFixed(2)}</p>
                                        </div>
                                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setSelectedRate(rate);
                                              setRateModalSupplierId(supplier.id);
                                              setIsRateModalOpen(true);
                                            }}
                                            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                                            title="Edit Rate"
                                          >
                                            <Edit size={14} />
                                          </button>
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setRateDeleteConfirm({ supplierId: supplier.id, rateId: rate.id, productName: rate.productName });
                                            }}
                                            className="p-1.5 text-red-600 hover:bg-red-50 rounded-md transition-colors"
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
                                <p className="text-sm text-gray-500 italic">No negotiated rates defined for this supplier.</p>
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
      </Motion.div>

      {/* Supplier Form Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        title={selectedSupplier ? 'Edit Supplier' : 'Add New Supplier'}
      >
        <SupplierForm supplier={selectedSupplier} onClose={handleCloseModal} />
      </Modal>

      {/* Rate Form Modal */}
      <Modal
        isOpen={isRateModalOpen}
        onClose={handleCloseRateModal}
        title={selectedRate ? 'Edit Negotiated Rate' : 'Add Negotiated Rate'}
      >
        <RateForm 
          supplierId={rateModalSupplierId} 
          rate={selectedRate}
          onClose={handleCloseRateModal} 
        />
      </Modal>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {deleteConfirm && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
            <Motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-xl shadow-2xl max-w-sm w-full mx-4 p-6"
            >
              <div className="flex gap-4 mb-4">
                <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <AlertCircle className="w-6 h-6 text-red-600" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Delete Supplier?</h3>
                  <p className="text-gray-600 text-sm mt-1">
                    Are you sure you want to delete <span className="font-semibold">{deleteConfirm.name}</span>? This action cannot be undone.
                  </p>
                </div>
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="flex-1 bg-gray-200 text-gray-700 py-2 rounded-lg font-medium hover:bg-gray-300 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDelete}
                  disabled={loading}
                  className="flex-1 bg-red-600 text-white py-2 rounded-lg font-medium hover:bg-red-700 disabled:bg-gray-400 transition-colors flex items-center justify-center gap-2"
                >
                  {loading && (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  )}
                  Delete
                </button>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Rate Delete Confirmation Modal */}
      <AnimatePresence>
        {rateDeleteConfirm && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
            <Motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-xl shadow-2xl max-w-sm w-full mx-4 p-6"
            >
              <div className="flex gap-4 mb-4">
                <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <AlertCircle className="w-6 h-6 text-red-600" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Delete Rate?</h3>
                  <p className="text-gray-600 text-sm mt-1">
                    Are you sure you want to delete the rate for <span className="font-semibold">{rateDeleteConfirm.productName}</span>?
                  </p>
                </div>
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setRateDeleteConfirm(null)}
                  className="flex-1 bg-gray-200 text-gray-700 py-2 rounded-lg font-medium hover:bg-gray-300 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    await dispatch(deleteSupplierRate({ supplierId: rateDeleteConfirm.supplierId, rateId: rateDeleteConfirm.rateId })).unwrap();
                    setRateDeleteConfirm(null);
                    toast.success('Rate deleted successfully');
                  }}
                  disabled={loading}
                  className="flex-1 bg-red-600 text-white py-2 rounded-lg font-medium hover:bg-red-700 disabled:bg-gray-400 transition-colors flex items-center justify-center gap-2"
                >
                  {loading && (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  )}
                  Delete
                </button>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>
    </Motion.div>
  );
}
