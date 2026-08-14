import { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { motion as Motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { createSupplier, updateSupplier, clearError } from '../store/supplierSlice';
import { Button, Field, Input, Select, Textarea } from './ui';
import { cn } from '../lib/cn';

const SUPPLIER_TYPES = ['SUPPLIER', 'TRUCKING_COMPANY'];

const formatTypeLabel = (str) => {
  if (!str) return '';
  return str.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
};

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
      errors.phone = 'Phone number must be exactly 10 digits';
    }

    setValidationErrors(errors);
    return errors;
  };

  const isValidEmail = (email) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const isValidPhone = (phone) => {
    return /^[\d\s\-+()]+$/.test(phone) && phone.replace(/\D/g, '').length === 10;
  };

  const isValidDomain = (domain) => {
    return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(domain);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;

    let finalValue = value;
    if (name === 'phone') {
      finalValue = value.replace(/\D/g, '');
    }

    setFormData(prev => ({
      ...prev,
      [name]: finalValue,
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
      <Motion.div variants={itemVariants}>
        <Field label="Supplier name" htmlFor="supplier-name" error={validationErrors.name}>
          <Input
            id="supplier-name"
            type="text"
            name="name"
            value={formData.name}
            onChange={handleChange}
            placeholder="Enter supplier name"
            className={cn(validationErrors.name && 'border-clay')}
          />
        </Field>
      </Motion.div>

      <Motion.div variants={itemVariants}>
        <Field label="Supplier type" htmlFor="supplier-type" error={validationErrors.type}>
          <Select
            id="supplier-type"
            name="type"
            value={formData.type}
            onChange={handleChange}
            className={cn(validationErrors.type && 'border-clay')}
          >
            {SUPPLIER_TYPES.map(type => (
              <option key={type} value={type}>{formatTypeLabel(type)}</option>
            ))}
          </Select>
        </Field>
      </Motion.div>

      <Motion.div variants={itemVariants}>
        <Field
          label="Email domains"
          hint="Comma separated"
          htmlFor="supplier-email-domains"
          error={validationErrors.emailDomains}
        >
          <Input
            id="supplier-email-domains"
            type="text"
            name="emailDomains"
            value={formData.emailDomains}
            onChange={handleChange}
            placeholder="example.com, supplier.example.com"
            className={cn(validationErrors.emailDomains && 'border-clay')}
          />
        </Field>
      </Motion.div>

      <Motion.div variants={itemVariants}>
        <Field
          label="Identification keywords"
          hint="Comma separated, used when reading tickets"
          htmlFor="supplier-keywords"
        >
          <Input
            id="supplier-keywords"
            type="text"
            name="keywords"
            value={formData.keywords}
            onChange={handleChange}
            placeholder="e.g. DUFFERIN, CGC, Miller Paving"
          />
        </Field>
      </Motion.div>

      <Motion.div variants={itemVariants}>
        <Field label="Contact name" htmlFor="supplier-contact-name">
          <Input
            id="supplier-contact-name"
            type="text"
            name="contactName"
            value={formData.contactName}
            onChange={handleChange}
            placeholder="Enter contact name"
          />
        </Field>
      </Motion.div>

      <Motion.div variants={itemVariants}>
        <Field label="Contact email" htmlFor="supplier-contact-email" error={validationErrors.contactEmail}>
          <Input
            id="supplier-contact-email"
            type="email"
            name="contactEmail"
            value={formData.contactEmail}
            onChange={handleChange}
            placeholder="Enter contact email"
            className={cn(validationErrors.contactEmail && 'border-clay')}
          />
        </Field>
      </Motion.div>

      <Motion.div variants={itemVariants}>
        <Field label="Phone" htmlFor="supplier-phone" error={validationErrors.phone}>
          <Input
            id="supplier-phone"
            type="tel"
            name="phone"
            value={formData.phone}
            onChange={handleChange}
            placeholder="Enter phone number"
            className={cn(validationErrors.phone && 'border-clay')}
          />
        </Field>
      </Motion.div>

      <Motion.div variants={itemVariants}>
        <Field label="Address" htmlFor="supplier-address">
          <Textarea
            id="supplier-address"
            name="address"
            value={formData.address}
            onChange={handleChange}
            placeholder="Enter address"
            rows={3}
            className="resize-none"
          />
        </Field>
      </Motion.div>

      <Motion.div variants={itemVariants} className="flex gap-3 pt-4">
        <Button
          type="submit"
          variant="primary"
          disabled={loading}
          className="flex-1"
        >
          {loading && (
            <div className="w-4 h-4 border-2 border-on-brand border-t-transparent rounded-pill animate-spin" />
          )}
          {supplier ? 'Update supplier details' : 'Create supplier'}
        </Button>
        <Button
          type="button"
          onClick={onClose}
          className="flex-1"
        >
          Close
        </Button>
      </Motion.div>
    </Motion.form>
  );
}
