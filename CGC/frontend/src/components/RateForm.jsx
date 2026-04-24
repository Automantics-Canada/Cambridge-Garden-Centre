import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { motion as Motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { addSupplierRate, updateSupplierRate } from '../store/supplierSlice';
import { fetchProducts } from '../store/productSlice';

export default function RateForm({ supplierId, rate, onClose }) {
  const dispatch = useDispatch();
  const { loading } = useSelector((state) => state.suppliers);
  const { products } = useSelector((state) => state.products);

  const [formData, setFormData] = useState({
    productName: '',
    rate: '',
    unit: 'tonne',
    effectiveFrom: new Date().toISOString().split('T')[0],
    notes: '',
  });

  const unitOptions = ['ton', 'kg', 'lb', 'load', 'yard', 'meter', 'each'];

  const [errors, setErrors] = useState({});

  useEffect(() => {
    dispatch(fetchProducts());
  }, [dispatch]);

  useEffect(() => {
    if (rate) {
      setFormData({
        productName: rate.productName || '',
        rate: rate.rate || '',
        unit: rate.unit || 'tonne',
        effectiveFrom: rate.effectiveFrom ? new Date(rate.effectiveFrom).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        notes: rate.notes || '',
      });
    }
  }, [rate]);

  const validate = () => {
    const newErrors = {};
    if (!formData.productName.trim()) newErrors.productName = 'Product is required';
    if (!formData.rate || formData.rate <= 0) newErrors.rate = 'Valid rate is required';
    if (!formData.unit.trim()) newErrors.unit = 'Unit is required';
    if (!formData.effectiveFrom) newErrors.effectiveFrom = 'Effective date is required';
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    try {
      if (rate) {
        // Update mode
        await dispatch(updateSupplierRate({ 
          supplierId, 
          rateId: rate.id,
          data: {
            ...formData,
            rate: Number(formData.rate)
          } 
        })).unwrap();
        toast.success('Rate updated successfully');
      } else {
        // Add mode
        await dispatch(addSupplierRate({ 
          supplierId, 
          data: {
            ...formData,
            rate: Number(formData.rate)
          } 
        })).unwrap();
        toast.success('Rate added successfully');
      }
      onClose();
    } catch (err) {
      toast.error(err || 'Failed to save rate');
    }
  };

   const handleChange = (e) => {
    const { name, value } = e.target;
    
    if (name === 'productName') {
      const selectedProduct = products.find(p => p.name === value);
      if (selectedProduct && selectedProduct.unit) {
        setFormData(prev => ({ ...prev, productName: value, unit: selectedProduct.unit }));
      } else {
        setFormData(prev => ({ ...prev, productName: value }));
      }
    } else {
      setFormData(prev => ({ ...prev, [name]: value }));
    }

    if (errors[name]) {
      setErrors(prev => ({ ...prev, [name]: '' }));
    }
  };

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.05 },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 10 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <Motion.form
      onSubmit={handleSubmit}
      className="space-y-4"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <Motion.div variants={itemVariants}>
        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">
          Product *
        </label>
        <select
          name="productName"
          value={formData.productName}
          onChange={handleChange}
          className={`w-full border rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-green-100 transition-all ${
            errors.productName ? 'border-red-500' : 'border-gray-200'
          }`}
        >
          <option value="">Select a product</option>
          {products.map(p => (
            <option key={p.id} value={p.name}>{p.name}</option>
          ))}
        </select>
        {errors.productName && <p className="text-red-500 text-[10px] mt-1">{errors.productName}</p>}
        {products.length === 0 && (
          <p className="text-[10px] text-amber-600 mt-1">
            No products found. Please add products in the Products section first.
          </p>
        )}
      </Motion.div>

      <div className="grid grid-cols-2 gap-4">
        <Motion.div variants={itemVariants}>
          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">
            Rate ($) *
          </label>
          <input
            type="number"
            name="rate"
            step="0.01"
            value={formData.rate}
            onChange={handleChange}
            placeholder="0.00"
            className={`w-full border rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-green-100 transition-all ${
              errors.rate ? 'border-red-500' : 'border-gray-200'
            }`}
          />
          {errors.rate && <p className="text-red-500 text-[10px] mt-1">{errors.rate}</p>}
        </Motion.div>

         <Motion.div variants={itemVariants}>
          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">
            Unit *
          </label>
          <select
            name="unit"
            value={formData.unit}
            onChange={handleChange}
            className={`w-full border rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-green-100 transition-all ${
              errors.unit ? 'border-red-500' : 'border-gray-200'
            }`}
          >
            {unitOptions.map(unit => (
              <option key={unit} value={unit}>{unit.toUpperCase()}</option>
            ))}
          </select>
          {errors.unit && <p className="text-red-500 text-[10px] mt-1">{errors.unit}</p>}
        </Motion.div>
      </div>

      <Motion.div variants={itemVariants}>
        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">
          Effective From *
        </label>
        <input
          type="date"
          name="effectiveFrom"
          value={formData.effectiveFrom}
          onChange={handleChange}
          className={`w-full border rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-green-100 transition-all ${
            errors.effectiveFrom ? 'border-red-500' : 'border-gray-200'
          }`}
        />
        {errors.effectiveFrom && <p className="text-red-500 text-[10px] mt-1">{errors.effectiveFrom}</p>}
      </Motion.div>

      <Motion.div variants={itemVariants}>
        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">
          Notes
        </label>
        <textarea
          name="notes"
          value={formData.notes}
          onChange={handleChange}
          placeholder="Optional notes..."
          className="w-full border border-gray-200 rounded-xl p-2.5 text-sm outline-none focus:ring-2 focus:ring-green-100 transition-all h-20 resize-none"
        />
      </Motion.div>

      <Motion.div variants={itemVariants} className="pt-4 flex gap-3">
        <button
          type="button"
          onClick={onClose}
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
          {rate ? 'Update Rate' : 'Add Rate'}
        </button>
      </Motion.div>
    </Motion.form>
  );
}
