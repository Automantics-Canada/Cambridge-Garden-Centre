import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { Plus, Edit, Trash2, AlertCircle, Package, Settings } from 'lucide-react';
import toast from 'react-hot-toast';
import { fetchProducts, createProduct, updateProduct, deleteProduct, fetchUnits, createCustomUnit, deleteCustomUnit, clearSuccess, clearError } from '../../store/productSlice';
import Modal from '../../components/Modal';
import { Skeleton } from '../../components/Skeleton';
import { formatDate } from '../../lib/date';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
} from '../../components/ui';

export default function ProductPage() {
  const dispatch = useDispatch();
  const { products, units, loading, unitsLoading, error, success, successMessage } = useSelector((state) => state.products);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isUnitsModalOpen, setIsUnitsModalOpen] = useState(false);
  const [isAddingUnit, setIsAddingUnit] = useState(false);
  const [deletingUnitId, setDeletingUnitId] = useState(null);
  const [newUnitName, setNewUnitName] = useState('');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [productName, setProductName] = useState('');
  const [productUnit, setProductUnit] = useState('ton');

  useEffect(() => {
    dispatch(fetchProducts());
    dispatch(fetchUnits());
  }, [dispatch]);

  useEffect(() => {
    if (success) {
      toast.success(successMessage);
       dispatch(clearSuccess());
      setIsModalOpen(false);
      setProductName('');
      setProductUnit('ton');
      setSelectedProduct(null);
    }
  }, [success, successMessage, dispatch]);

  useEffect(() => {
    if (error) {
      toast.error(error);
      dispatch(clearError());
    }
  }, [error, dispatch]);

   const handleCreateNew = () => {
    setSelectedProduct(null);
    setProductName('');
    setProductUnit('ton');
    setIsModalOpen(true);
  };

   const handleEdit = (product) => {
    setSelectedProduct(product);
    setProductName(product.name);
    setProductUnit(product.unit || 'ton');
    setIsModalOpen(true);
  };

  const handleDelete = (product) => {
    setDeleteConfirm(product);
  };

  const confirmDelete = async () => {
    if (deleteConfirm) {
      try {
        await dispatch(deleteProduct(deleteConfirm.id)).unwrap();
      } catch (err) {
        toast.error(err || 'Failed to delete product');
      }
      setDeleteConfirm(null);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!productName.trim()) {
      toast.error('Product name is required');
      return;
    }

     if (selectedProduct) {
      dispatch(updateProduct({ id: selectedProduct.id, name: productName.trim(), unit: productUnit }));
    } else {
      dispatch(createProduct({ name: productName.trim(), unit: productUnit }));
    }
  };

  const handleCreateUnit = async (e) => {
    e.preventDefault();
    if (!newUnitName.trim()) {
      toast.error('Unit name is required');
      return;
    }
    setIsAddingUnit(true);
    try {
      await dispatch(createCustomUnit({ name: newUnitName.trim() })).unwrap();
      setNewUnitName('');
    } catch (err) {
      toast.error(err || 'Failed to create unit');
    } finally {
      setIsAddingUnit(false);
    }
  };

  const handleDeleteUnit = async (id) => {
    setDeletingUnitId(id);
    try {
      await dispatch(deleteCustomUnit(id)).unwrap();
    } catch (err) {
      toast.error(err || 'Failed to delete unit');
    } finally {
      setDeletingUnitId(null);
    }
  };

  const filteredProducts = products.filter(product =>
    product.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { staggerChildren: 0.1 } },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <Motion.div
      className="max-w-7xl mx-auto space-y-6"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <Motion.div variants={itemVariants}>
        <PageHeader
          title="Products"
          subtitle="The materials you buy. Rates are attached to these names."
          actions={
            <div className="flex gap-2">
              <Button onClick={() => setIsUnitsModalOpen(true)}>
                <Settings size={18} />
                Manage units
              </Button>
              <Button variant="primary" onClick={handleCreateNew}>
                <Plus size={18} />
                Add product
              </Button>
            </div>
          }
        />
      </Motion.div>

      <Motion.div variants={itemVariants}>
        <Card className="p-4">
          <Input
            type="text"
            placeholder="Search products..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full sm:max-w-md"
          />
        </Card>
      </Motion.div>

      <Motion.div variants={itemVariants}>
        <Card className="overflow-hidden">
          {loading && products.length === 0 ? (
            <ProductTableSkeleton />
          ) : filteredProducts.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No products found"
              message={products.length === 0 ? 'Add the first product so you can attach negotiated rates to it.' : 'Try a different search.'}
              action={products.length === 0 ? (
                <Button variant="primary" onClick={handleCreateNew}>
                  <Plus size={20} />
                  Add first product
                </Button>
              ) : undefined}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-ink/[0.03] border-b border-line">
                    <th className="text-left px-6 py-4 font-semibold text-muted">Product name</th>
                    <th className="text-left px-6 py-4 font-semibold text-muted">Unit</th>
                    <th className="text-left px-6 py-4 font-semibold text-muted">Created</th>
                    <th className="text-right px-6 py-4 font-semibold text-muted">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.map((product, index) => (
                    <Motion.tr
                      key={product.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className="border-b border-line hover:bg-brand/[0.04] transition-colors"
                    >
                      <td className="px-6 py-4">
                        <p className="font-medium text-ink">{product.name}</p>
                      </td>
                      <td className="px-6 py-4">
                        <Badge tone="neutral">{product.unit || 'ton'}</Badge>
                      </td>
                      <td className="px-6 py-4">
                        <p className="tabular text-muted text-sm">{formatDate(product.createdAt)}</p>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex justify-end gap-3">
                          <Motion.button
                            onClick={() => handleEdit(product)}
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.9 }}
                            className="p-2 text-brand hover:bg-brand/10 rounded-control transition-colors"
                            title="Edit Product"
                          >
                            <Edit size={18} />
                          </Motion.button>
                          <Motion.button
                            onClick={() => handleDelete(product)}
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.9 }}
                            className="p-2 text-clay hover:bg-clay/10 rounded-control transition-colors"
                            title="Delete Product"
                          >
                            <Trash2 size={18} />
                          </Motion.button>
                        </div>
                      </td>
                    </Motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Motion.div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={selectedProduct ? 'Edit product' : 'Add product'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Product name" htmlFor="product-name">
            <Input
              id="product-name"
              type="text"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder="e.g. Type A Gravel"
              autoFocus
            />
          </Field>
          <Field label="Base unit" htmlFor="product-unit">
            <Select
              id="product-unit"
              value={productUnit}
              onChange={(e) => setProductUnit(e.target.value)}
            >
              {units.allUnits.map(unit => (
                <option key={unit} value={unit}>{unit.toUpperCase()}</option>
              ))}
            </Select>
          </Field>
          <div className="pt-4 flex gap-3">
            <Button type="button" onClick={() => setIsModalOpen(false)} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={loading} className="flex-1">
              {loading && <div className="w-4 h-4 border-2 border-on-brand border-t-transparent rounded-pill animate-spin" />}
              {selectedProduct ? 'Update product' : 'Add product'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isUnitsModalOpen}
        onClose={() => setIsUnitsModalOpen(false)}
        title="Manage custom units"
      >
        <div className="space-y-6">
          <form onSubmit={handleCreateUnit} className="flex gap-2">
            <Input
              type="text"
              value={newUnitName}
              onChange={(e) => setNewUnitName(e.target.value)}
              placeholder="e.g. box, bag, pack"
              className="flex-1"
            />
            <Button
              type="submit"
              variant="primary"
              disabled={isAddingUnit || unitsLoading}
            >
              {isAddingUnit ? <div className="w-4 h-4 border-2 border-on-brand border-t-transparent rounded-pill animate-spin" /> : <Plus size={16} />}
              {isAddingUnit ? 'Adding...' : 'Add unit'}
            </Button>
          </form>

          <div className="space-y-2">
            <h4 className="text-[13px] font-semibold text-muted">
              Your custom units
            </h4>
            {units?.customUnits?.length === 0 ? (
              <p className="text-muted text-sm py-2">No custom units added yet.</p>
            ) : (
              <div className="max-h-60 overflow-y-auto border border-line rounded-control divide-y divide-line">
                {units?.customUnits?.map((unit) => (
                  <div key={unit.id} className="flex items-center justify-between p-3 bg-ink/[0.02] hover:bg-ink/[0.04] transition-colors">
                    <span className="font-semibold text-ink text-sm">
                      {unit.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDeleteUnit(unit.id)}
                      disabled={deletingUnitId === unit.id || unitsLoading}
                      className="p-1.5 text-clay hover:bg-clay/10 rounded-control transition-colors disabled:opacity-50 flex items-center justify-center"
                      title="Delete Unit"
                    >
                      {deletingUnitId === unit.id ? (
                        <div className="w-4 h-4 border-2 border-clay border-t-transparent rounded-pill animate-spin" />
                      ) : (
                        <Trash2 size={16} />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pt-2 border-t border-line">
            <Button
              type="button"
              onClick={() => setIsUnitsModalOpen(false)}
              className="w-full"
            >
              Close
            </Button>
          </div>
        </div>
      </Modal>

      <AnimatePresence>
        {deleteConfirm && (
          <div className="fixed inset-0 bg-scrim/50 z-50 flex items-center justify-center">
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
                  <h3 className="text-lg font-bold text-ink">Delete product?</h3>
                  <p className="text-muted text-sm mt-1">
                    Are you sure you want to delete <span className="font-semibold text-ink">{deleteConfirm.name}</span>? This action cannot be undone and may affect rates.
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
                  {loading && <div className="w-4 h-4 border-2 border-on-clay border-t-transparent rounded-pill animate-spin" />}
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
function ProductTableSkeleton() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="bg-ink/[0.03] border-b border-line">
            <th className="text-left px-6 py-4 font-semibold text-muted">Product name</th>
            <th className="text-left px-6 py-4 font-semibold text-muted">Unit</th>
            <th className="text-left px-6 py-4 font-semibold text-muted">Created</th>
            <th className="text-right px-6 py-4 font-semibold text-muted">Actions</th>
          </tr>
        </thead>
        <tbody>
          {[...Array(8)].map((_, i) => (
            <tr key={i} className="border-b border-line">
              <td className="px-6 py-4">
                <Skeleton variant="text" width="200px" height="16px" />
              </td>
              <td className="px-6 py-4">
                <Skeleton variant="rectangle" width="40px" height="20px" className="rounded" />
              </td>
              <td className="px-6 py-4">
                <Skeleton variant="text" width="120px" height="16px" />
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
