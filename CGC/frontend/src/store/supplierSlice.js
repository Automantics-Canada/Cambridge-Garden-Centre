import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../api/axios';

// Async thunks
export const fetchSuppliers = createAsyncThunk(
  'suppliers/fetchSuppliers',
  async (_, { rejectWithValue }) => {
    try {
      const response = await api.get('/supplier');
      return response.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error || error.response?.data?.message || 'Failed to fetch suppliers');
    }
  }
);

export const createSupplier = createAsyncThunk(
  'suppliers/createSupplier',
  async (supplierData, { rejectWithValue }) => {
    try {
      const response = await api.post('/supplier', supplierData);
      return response.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error || error.response?.data?.message || 'Failed to create supplier');
    }
  }
);

export const updateSupplier = createAsyncThunk(
  'suppliers/updateSupplier',
  async ({ id, data }, { rejectWithValue }) => {
    try {
      const response = await api.put(`/supplier/${id}`, data);
      return response.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error || error.response?.data?.message || 'Failed to update supplier');
    }
  }
);

export const deleteSupplier = createAsyncThunk(
  'suppliers/deleteSupplier',
  async (id, { rejectWithValue }) => {
    try {
      const response = await api.delete(`/supplier/${id}`);
      return id;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error || error.response?.data?.message || 'Failed to delete supplier');
    }
  }
);

export const addSupplierRate = createAsyncThunk(
  'suppliers/addSupplierRate',
  async ({ supplierId, data }, { rejectWithValue }) => {
    try {
      const response = await api.post(`/supplier/${supplierId}/rates`, data);
      return { supplierId, rate: response.data };
    } catch (error) {
      return rejectWithValue(error.response?.data?.error || 'Failed to add rate');
    }
  }
);

export const deleteSupplierRate = createAsyncThunk(
  'suppliers/deleteSupplierRate',
  async ({ supplierId, rateId }, { rejectWithValue }) => {
    try {
      await api.delete(`/supplier/${supplierId}/rates/${rateId}`);
      return { supplierId, rateId };
    } catch (error) {
      return rejectWithValue(error.response?.data?.error || 'Failed to delete rate');
    }
  }
);

const initialState = {
  suppliers: [],
  loading: false,
  error: null,
  success: false,
  successMessage: '',
};

const supplierSlice = createSlice({
  name: 'suppliers',
  initialState,
  reducers: {
    clearError: (state) => {
      state.error = null;
    },
    clearSuccess: (state) => {
      state.success = false;
      state.successMessage = '';
    },
  },
  extraReducers: (builder) => {
    // Fetch suppliers
    builder
      .addCase(fetchSuppliers.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchSuppliers.fulfilled, (state, action) => {
        state.loading = false;
        state.suppliers = action.payload || [];
        state.error = null;
      })
      .addCase(fetchSuppliers.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });

    // Create supplier
    builder
      .addCase(createSupplier.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(createSupplier.fulfilled, (state, action) => {
        state.loading = false;
        state.suppliers.push(action.payload);
        state.success = true;
        state.successMessage = 'Supplier created successfully';
        state.error = null;
      })
      .addCase(createSupplier.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });

    // Update supplier
    builder
      .addCase(updateSupplier.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(updateSupplier.fulfilled, (state, action) => {
        state.loading = false;
        const index = state.suppliers.findIndex(s => s.id === action.payload.id);
        if (index !== -1) {
          state.suppliers[index] = action.payload;
        }
        state.success = true;
        state.successMessage = 'Supplier updated successfully';
        state.error = null;
      })
      .addCase(updateSupplier.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });

    // Delete supplier
    builder
      .addCase(deleteSupplier.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(deleteSupplier.fulfilled, (state, action) => {
        state.loading = false;
        state.suppliers = state.suppliers.filter(s => s.id !== action.payload);
        state.success = true;
        state.successMessage = 'Supplier deleted successfully';
        state.error = null;
      })
      .addCase(deleteSupplier.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });

    // Add Rate
    builder
      .addCase(addSupplierRate.pending, (state) => {
        state.loading = true;
      })
      .addCase(addSupplierRate.fulfilled, (state, action) => {
        state.loading = false;
        const supplier = state.suppliers.find(s => s.id === action.payload.supplierId);
        if (supplier) {
          if (!supplier.negotiatedRates) supplier.negotiatedRates = [];
          supplier.negotiatedRates.push(action.payload.rate);
        }
      })
      .addCase(addSupplierRate.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });

    // Delete Rate
    builder
      .addCase(deleteSupplierRate.pending, (state) => {
        state.loading = true;
      })
      .addCase(deleteSupplierRate.fulfilled, (state, action) => {
        state.loading = false;
        const supplier = state.suppliers.find(s => s.id === action.payload.supplierId);
        if (supplier && supplier.negotiatedRates) {
          supplier.negotiatedRates = supplier.negotiatedRates.filter(r => r.id !== action.payload.rateId);
        }
      })
      .addCase(deleteSupplierRate.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });
  },
});

export const { clearError, clearSuccess } = supplierSlice.actions;
export default supplierSlice.reducer;
