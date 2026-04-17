import { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { motion as Motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { createSupplier, updateSupplier, clearError } from '../store/supplierSlice';

const SUPPLIER_TYPES = ['SUPPLIER', 'TRUCKING_COMPANY'];

export default function SupplierForm({ supplier = null, onClose }) {
  const dispatch = useDispatch();
  const { loading, error } = useSelector((state) => state.suppliers);
  
  const [formData, setFormData] = useState({
    name: supplier?.name || '',
    type: SUPPLIER_TYPES.includes(supplier?.type) ? supplier.type : 'SUPPLIER',
    emailDomains: supplier?.emailDomains?.join(', ') || '',
    keywords: supplier?.keywords?.join(', ') || '',
    contactName: supplier?.contactName || '',
    contactEmail: supplier?.contactEmail || '',
    phone: supplier?.phone || '',
    address: supplier?.address || '',
  });



  const [validationErrors, setValidationErrors] = useState({});

  useEffect(() => {
    return () => {
      dispatch(clearError());
    };
  }, [dispatch]);

  const validateForm = () => {
    const errors = {};
    
    if (!formData.name.trim()) {
      errors.name = 'Supplier name is required';
    }
    
    if (!formData.type) {
      errors.type = 'Supplier type is required';
    }

    if (formData.emailDomains.trim()) {
      const domains = formData.emailDomains.split(',').map(d => d.trim()).filter(Boolean);
      const invalidDomains = domains.filter(d => !isValidDomain(d));
      if (invalidDomains.length > 0) {
        errors.emailDomains = 'Invalid domain format. Use domains (e.g., gmail.com), not emails.';
      }
    }

    if (formData.contactEmail && !isValidEmail(formData.contactEmail)) {
      errors.contactEmail = 'Invalid email address';
    }

    if (formData.phone && !isValidPhone(formData.phone)) {
      errors.phone = 'Invalid phone number';
    }

    setValidationErrors(errors);
    return errors;
  };

  const isValidEmail = (email) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const isValidPhone = (phone) => {
    return /^[\d\s\-+()]+$/.test(phone) && phone.replace(/\D/g, '').length >= 10;
  };

  const isValidDomain = (domain) => {
    return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(domain);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value,
    }));
    if (validationErrors[name]) {
      setValidationErrors(prev => ({
        ...prev,
        [name]: '',
      }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    const errors = validateForm();
    const errorKeys = Object.keys(errors);
    if (errorKeys.length > 0) {
      toast.error(errors[errorKeys[0]]);
      return;
    }

    const submitData = {
      ...formData,
      emailDomains: formData.emailDomains.trim() ? formData.emailDomains.split(',').map(d => d.trim()).filter(Boolean) : [],
      keywords: formData.keywords.trim() ? formData.keywords.split(',').map(k => k.trim()).filter(Boolean) : [],
    };

    try {
      if (supplier) {
        await dispatch(updateSupplier({ id: supplier.id, data: submitData })).unwrap();
        toast.success('Supplier updated successfully!');
      } else {
        await dispatch(createSupplier(submitData)).unwrap();
        toast.success('Supplier created successfully!');
      }
      onClose();
    } catch (err) {
      toast.error(error || err || 'Failed to save supplier');
    }
  };

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
      {/* Name */}
      <Motion.div variants={itemVariants}>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Supplier Name *
        </label>
        <input
          type="text"
          name="name"
          value={formData.name}
          onChange={handleChange}
          placeholder="Enter supplier name"
          className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition ${
            validationErrors.name ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {validationErrors.name && (
          <p className="text-red-500 text-sm mt-1">{validationErrors.name}</p>
        )}
      </Motion.div>

      {/* Type */}
      <Motion.div variants={itemVariants}>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Supplier Type *
        </label>
        <select
          name="type"
          value={formData.type}
          onChange={handleChange}
          className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition ${
            validationErrors.type ? 'border-red-500' : 'border-gray-300'
          }`}
        >
          {SUPPLIER_TYPES.map(type => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
        {validationErrors.type && (
          <p className="text-red-500 text-sm mt-1">{validationErrors.type}</p>
        )}
      </Motion.div>

      {/* Email Domains */}
      <Motion.div variants={itemVariants}>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Email Domains <span className="text-xs text-gray-500">(comma separated)</span>
        </label>
        <input
          type="text"
          name="emailDomains"
          value={formData.emailDomains}
          onChange={handleChange}
          placeholder="example.com, supplier.example.com"
          className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition ${
            validationErrors.emailDomains ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {validationErrors.emailDomains && (
          <p className="text-red-500 text-sm mt-1">{validationErrors.emailDomains}</p>
        )}
      </Motion.div>

      {/* Keywords */}
      <Motion.div variants={itemVariants}>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Identification Keywords <span className="text-xs text-gray-500">(comma separated, for WhatsApp/OCR)</span>
        </label>
        <input
          type="text"
          name="keywords"
          value={formData.keywords}
          onChange={handleChange}
          placeholder="e.g. DUFFERIN, CGC, Miller Paving"
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
        />
      </Motion.div>

      {/* Contact Name */}
      <Motion.div variants={itemVariants}>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Contact Name
        </label>
        <input
          type="text"
          name="contactName"
          value={formData.contactName}
          onChange={handleChange}
          placeholder="Enter contact name"
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
        />
      </Motion.div>

      {/* Contact Email */}
      <Motion.div variants={itemVariants}>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Contact Email
        </label>
        <input
          type="email"
          name="contactEmail"
          value={formData.contactEmail}
          onChange={handleChange}
          placeholder="Enter contact email"
          className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition ${
            validationErrors.contactEmail ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {validationErrors.contactEmail && (
          <p className="text-red-500 text-sm mt-1">{validationErrors.contactEmail}</p>
        )}
      </Motion.div>

      {/* Phone */}
      <Motion.div variants={itemVariants}>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Phone
        </label>
        <input
          type="tel"
          name="phone"
          value={formData.phone}
          onChange={handleChange}
          placeholder="Enter phone number"
          className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition ${
            validationErrors.phone ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {validationErrors.phone && (
          <p className="text-red-500 text-sm mt-1">{validationErrors.phone}</p>
        )}
      </Motion.div>

      {/* Address */}
      <Motion.div variants={itemVariants}>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Address
        </label>
        <textarea
          name="address"
          value={formData.address}
          onChange={handleChange}
          placeholder="Enter address"
          rows="3"
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition resize-none"
        />
      </Motion.div>

      {/* Submit Button */}
      <Motion.div variants={itemVariants} className="flex gap-3 pt-4">
        <button
          type="submit"
          disabled={loading}
          className="flex-1 bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700 disabled:bg-gray-400 transition-colors flex items-center justify-center gap-2"
        >
          {loading && (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          )}
          {supplier ? 'Update Supplier Details' : 'Create Supplier'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex-1 bg-gray-200 text-gray-700 py-2 rounded-lg font-medium hover:bg-gray-300 transition-colors"
        >
          Close
        </button>
      </Motion.div>
    </Motion.form>
  );
}
