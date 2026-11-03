import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { motion as Motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { addSupplierRate, fetchSuppliers, updateSupplierRate } from '../store/supplierSlice';
import { fetchProducts } from '../store/productSlice';
import { Button, Field, Input, Select, Textarea } from './ui';
import { cn } from '../lib/cn';
import { businessDayOf } from '../lib/date';
import {
  DEFAULT_RATE_UNIT,
  RATE_UNITS,
  changedRateFields,
  dayOf,
  rateUnitValue,
  validateRateForm,
} from '../lib/priceList';

function initialFormData(rate) {
  return {
    productName: rate?.productName || '',
    rate: rate?.rate ?? '',
    // New rates start in metric tonnes, the unit Spruce prints (MT). A stored
    // "ton" comes up blank so the person says which ton it was.
    unit: rate ? rateUnitValue(rate.unit) : DEFAULT_RATE_UNIT,
    effectiveFrom: rate ? dayOf(rate.effectiveFrom) : businessDayOf(),
    effectiveTo: rate ? dayOf(rate.effectiveTo) : '',
    notes: rate?.notes || '',
  };
}

const SAVED_MESSAGES = {
  CREATE: 'Rate added',
  SUPERSEDE: 'New price saved. The previous price stays on record for older invoices.',
  CORRECT: 'The rate on record was updated',
  UNCHANGED: 'This rate is already on record',
};

export default function RateForm({ supplierId, rate, onClose }) {
  const dispatch = useDispatch();
  const { suppliers, loading } = useSelector((state) => state.suppliers);
  const { products } = useSelector((state) => state.products);
  const currentSupplier = suppliers.find(s => s.id === supplierId);

  const [formData, setFormData] = useState(() => initialFormData(rate));
  const [errors, setErrors] = useState({});

  useEffect(() => {
    dispatch(fetchProducts());
  }, [dispatch]);

  // Other periods already held for this product, so the person knows a new
  // start date adds a price rather than replacing the old one.
  const otherPeriods = (currentSupplier?.negotiatedRates || []).filter(
    r => r.id !== rate?.id && r.productName.trim().toLowerCase() === formData.productName.trim().toLowerCase()
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    const found = validateRateForm(formData);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    try {
      if (rate) {
        const changes = changedRateFields(rate, formData);
        if (Object.keys(changes).length > 0) {
          await dispatch(updateSupplierRate({ supplierId, rateId: rate.id, data: changes })).unwrap();
          toast.success('Rate updated');
        }
      } else {
        const saved = await dispatch(addSupplierRate({
          supplierId,
          data: { ...formData, rate: Number(formData.rate) },
        })).unwrap();
        toast.success(SAVED_MESSAGES[saved?.rate?.action] || 'Rate saved');
      }
      dispatch(fetchSuppliers());
      onClose();
    } catch (err) {
      toast.error(err || 'Failed to save rate');
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    if (name === 'productName') {
      // Take the product's unit only when it is one a rate can be in.
      const productUnit = rateUnitValue(products.find(p => p.name === value)?.unit);
      setFormData(prev => ({ ...prev, productName: value, ...(productUnit && !rate ? { unit: productUnit } : {}) }));
    } else {
      setFormData(prev => ({ ...prev, [name]: value }));
    }
    if (errors[name]) setErrors(prev => ({ ...prev, [name]: '' }));
  };

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { staggerChildren: 0.05 } },
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
        <Field label="Product" htmlFor="rate-product" error={errors.productName}>
          <Select
            id="rate-product"
            name="productName"
            value={formData.productName}
            onChange={handleChange}
            className={cn(errors.productName && 'border-clay')}
          >
            <option value="">Select a product</option>
            {rate && rate.productName && !products.find(p => p.name === rate.productName) && (
              <option value={rate.productName}>{rate.productName}</option>
            )}
            {products.map(p => (
              <option key={p.id} value={p.name}>{p.name}</option>
            ))}
          </Select>
        </Field>
        {!rate && otherPeriods.length > 0 && (
          <p className="text-[12.5px] text-muted mt-1.5">
            This product already has a rate. A later start date adds the new price and ends the old one the day before;
            older invoices keep the old price. The same start date corrects that rate.
          </p>
        )}
        {products.length === 0 && (
          <p className="text-[12.5px] text-muted mt-1.5">
            No products found. Add products in the Products section first.
          </p>
        )}
      </Motion.div>

      <div className="grid grid-cols-2 gap-4">
        <Motion.div variants={itemVariants}>
          <Field label="Rate ($, before HST)" htmlFor="rate-amount" error={errors.rate}>
            <Input
              id="rate-amount"
              type="number"
              name="rate"
              min="0"
              step="0.01"
              value={formData.rate}
              onChange={handleChange}
              placeholder="0.00"
              className={cn('tabular', errors.rate && 'border-clay')}
            />
          </Field>
        </Motion.div>

        <Motion.div variants={itemVariants}>
          <Field label="Unit" htmlFor="rate-unit" error={errors.unit}>
            <Select
              id="rate-unit"
              name="unit"
              value={formData.unit}
              onChange={handleChange}
              className={cn(errors.unit && 'border-clay')}
            >
              <option value="">Choose a unit</option>
              {RATE_UNITS.map(unit => (
                <option key={unit.value} value={unit.value}>{unit.label}</option>
              ))}
            </Select>
          </Field>
          {rate && !rateUnitValue(rate.unit) && (
            <p className="text-[12.5px] text-ochre mt-1.5">
              Saved as “{rate.unit}”. Choose the unit this price is really in.
            </p>
          )}
        </Motion.div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Motion.div variants={itemVariants}>
          <Field label="Effective from" htmlFor="rate-effective" error={errors.effectiveFrom}>
            <Input
              id="rate-effective"
              type="date"
              name="effectiveFrom"
              value={formData.effectiveFrom}
              max={formData.effectiveTo || undefined}
              onChange={handleChange}
              className={cn('tabular', errors.effectiveFrom && 'border-clay')}
            />
          </Field>
        </Motion.div>
        <Motion.div variants={itemVariants}>
          <Field label="Effective to (optional)" htmlFor="rate-effective-to" error={errors.effectiveTo}>
            <Input
              id="rate-effective-to"
              type="date"
              name="effectiveTo"
              value={formData.effectiveTo}
              min={formData.effectiveFrom || undefined}
              onChange={handleChange}
              className={cn('tabular', errors.effectiveTo && 'border-clay')}
            />
          </Field>
        </Motion.div>
      </div>

      <Motion.div variants={itemVariants}>
        <Field label="Notes" htmlFor="rate-notes">
          <Textarea
            id="rate-notes"
            name="notes"
            value={formData.notes}
            onChange={handleChange}
            placeholder="Optional notes..."
            rows={3}
            className="resize-none"
          />
        </Field>
      </Motion.div>

      <Motion.div variants={itemVariants} className="pt-4 flex gap-3">
        <Button type="button" onClick={onClose} className="flex-1">
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={loading} className="flex-1">
          {loading && <div className="w-4 h-4 border-2 border-on-brand border-t-transparent rounded-pill animate-spin" />}
          {rate ? 'Update rate' : 'Add rate'}
        </Button>
      </Motion.div>
    </Motion.form>
  );
}
