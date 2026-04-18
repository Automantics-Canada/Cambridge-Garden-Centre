import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { Plus, Edit, Trash2, AlertCircle, Package } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { fetchProducts, createProduct, updateProduct, deleteProduct, clearSuccess, clearError } from '../../store/productSlice';
import Modal from '../../components/Modal';
import Loader from '../../components/Loader';

export default function ProductPage() {
  const dispatch = useDispatch();
  const { products, loading, error, success, successMessage } = useSelector((state) => state.products);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [productName, setProductName] = useState('');

  useEffect(() => {
    dispatch(fetchProducts());
  }, [dispatch]);

  useEffect(() => {
    if (success) {
      toast.success(successMessage);
      dispatch(clearSuccess());
      setIsModalOpen(false);
      setProductName('');
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
    setIsModalOpen(true);
  };

  const handleEdit = (product) => {
    setSelectedProduct(product);
    setProductName(product.name);
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
      dispatch(updateProduct({ id: selectedProduct.id, name: productName.trim() }));
    } else {
      dispatch(createProduct({ name: productName.trim() }));
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
        <h1 className="text-4xl font-bold text-gray-900 mb-2">Products</h1>
        <p className="text-gray-600">Manage the list of available products for negotiated rates</p>
      </Motion.div>

      <Motion.div
        variants={itemVariants}
        className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between"
      >
        <div className="flex flex-col sm:flex-row gap-3 flex-1 w-full sm:w-auto">
          <input
            type="text"
            placeholder="Search products..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none w-full sm:max-w-md"
          />
        </div>

        <Motion.button
          onClick={handleCreateNew}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          className="bg-green-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-green-700 transition-colors flex items-center gap-2 whitespace-nowrap"
        >
          <Plus size={20} />
          Add Product
        </Motion.button>
      </Motion.div>

      <Motion.div variants={itemVariants} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {loading && products.length === 0 ? (
          <Loader message="Loading products..." />
        ) : filteredProducts.length === 0 ? (
          <div className="p-12 text-center">
            <Package className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No products found</h3>
            <p className="text-gray-600 mb-6">
              {products.length === 0 ? 'Get started by adding your first product.' : 'Try adjusting your search filter.'}
            </p>
            {products.length === 0 && (
              <button
                onClick={handleCreateNew}
                className="bg-green-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-green-700 transition-colors inline-flex items-center gap-2"
              >
                <Plus size={20} />
                Add First Product
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-6 py-4 font-semibold text-gray-900">Product Name</th>
                  <th className="text-left px-6 py-4 font-semibold text-gray-900">Created At</th>
                  <th className="text-right px-6 py-4 font-semibold text-gray-900">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((product, index) => (
                  <Motion.tr
                    key={product.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.05 }}
                    className="border-b border-gray-200 hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-6 py-4">
                      <p className="font-medium text-gray-900">{product.name}</p>
                    </td>
                    <td className="px-6 py-4">
                      <p className="text-gray-600 text-sm">{new Date(product.createdAt).toLocaleDateString()}</p>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex justify-end gap-3">
                        <Motion.button
                          onClick={() => handleEdit(product)}
                          whileHover={{ scale: 1.1 }}
                          whileTap={{ scale: 0.9 }}
                          className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          title="Edit Product"
                        >
                          <Edit size={18} />
                        </Motion.button>
                        <Motion.button
                          onClick={() => handleDelete(product)}
                          whileHover={{ scale: 1.1 }}
                          whileTap={{ scale: 0.9 }}
                          className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
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
      </Motion.div>

      {/* Product Form Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={selectedProduct ? 'Edit Product' : 'Add New Product'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">
              Product Name *
            </label>
            <input
              type="text"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder="e.g. Type A Gravel"
              autoFocus
              className="w-full border border-gray-200 rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-green-100 transition-all"
            />
          </div>
          <div className="pt-4 flex gap-3">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="flex-1 py-2.5 text-sm font-bold text-gray-500 hover:bg-gray-100 rounded-xl transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2.5 text-sm font-bold text-white bg-green-600 hover:bg-green-700 rounded-xl transition-all shadow-lg shadow-green-100 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              {selectedProduct ? 'Update Product' : 'Add Product'}
            </button>
          </div>
        </form>
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
                  <h3 className="text-lg font-bold text-gray-900">Delete Product?</h3>
                  <p className="text-gray-600 text-sm mt-1">
                    Are you sure you want to delete <span className="font-semibold">{deleteConfirm.name}</span>? This action cannot be undone and may affect rates.
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
                  {loading && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
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
