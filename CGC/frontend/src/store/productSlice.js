import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../api/axios';

// Async thunks
export const fetchProducts = createAsyncThunk(
  'products/fetchProducts',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await api.get('/api/products');
      return Array.isArray(data) ? data : data?.data || [];
    } catch (error) {
      return rejectWithValue(error.response?.data?.error || error.message || 'Failed to fetch products');
    }
  }
);

export const createProduct = createAsyncThunk(
  'products/createProduct',
  async (productData, { rejectWithValue }) => {
    try {
      const response = await api.post('/api/products', productData);
      return response.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error || 'Failed to create product');
    }
  }
);

export const updateProduct = createAsyncThunk(
  'products/updateProduct',
  async ({ id, ...productData }, { rejectWithValue }) => {
    try {
      const response = await api.put(`/api/products/${id}`, productData);
      return response.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error || 'Failed to update product');
    }
  }
);

export const deleteProduct = createAsyncThunk(
  'products/deleteProduct',
  async (id, { rejectWithValue }) => {
    try {
      await api.delete(`/api/products/${id}`);
      return id;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error || 'Failed to delete product');
    }
  }
);

export const fetchUnits = createAsyncThunk(
  'products/fetchUnits',
  async (_, { rejectWithValue }) => {
    try {
      const response = await api.get('/api/products/units');
      return response.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error || 'Failed to fetch units');
    }
  }
);

export const createCustomUnit = createAsyncThunk(
  'products/createCustomUnit',
  async (unitData, { rejectWithValue }) => {
    try {
      const response = await api.post('/api/products/units', unitData);
      return response.data;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error || 'Failed to create unit');
    }
  }
);

export const deleteCustomUnit = createAsyncThunk(
  'products/deleteCustomUnit',
  async (id, { rejectWithValue }) => {
    try {
      await api.delete(`/api/products/units/${id}`);
      return id;
    } catch (error) {
      return rejectWithValue(error.response?.data?.error || 'Failed to delete unit');
    }
  }
);

const initialState = {
  products: [],
  units: {
    defaultUnits: [],
    customUnits: [],
    allUnits: ['ton', 'kg', 'lb', 'load', 'yard', 'meter', 'each', 'tm', 'cy'],
  },
  loading: false,
  unitsLoading: false,
  error: null,
  success: false,
  successMessage: '',
};

const productSlice = createSlice({
  name: 'products',
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
    // Fetch products
    builder
      .addCase(fetchProducts.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchProducts.fulfilled, (state, action) => {
        state.loading = false;
        state.products = action.payload || [];
      })
      .addCase(fetchProducts.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });

    // Create product
    builder
      .addCase(createProduct.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(createProduct.fulfilled, (state, action) => {
        state.loading = false;
        state.products.push(action.payload);
        state.success = true;
        state.successMessage = 'Product created successfully';
      })
      .addCase(createProduct.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });

    // Update product
    builder
      .addCase(updateProduct.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(updateProduct.fulfilled, (state, action) => {
        state.loading = false;
        const index = state.products.findIndex(p => p.id === action.payload.id);
        if (index !== -1) {
          state.products[index] = action.payload;
        }
        state.success = true;
        state.successMessage = 'Product updated successfully';
      })
      .addCase(updateProduct.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });

    // Delete product
    builder
      .addCase(deleteProduct.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(deleteProduct.fulfilled, (state, action) => {
        state.loading = false;
        state.products = state.products.filter(p => p.id !== action.payload);
        state.success = true;
        state.successMessage = 'Product deleted successfully';
      })
      .addCase(deleteProduct.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });

    // Fetch units
    builder
      .addCase(fetchUnits.pending, (state) => {
        state.unitsLoading = true;
        state.error = null;
      })
      .addCase(fetchUnits.fulfilled, (state, action) => {
        state.unitsLoading = false;
        state.units = action.payload;
      })
      .addCase(fetchUnits.rejected, (state, action) => {
        state.unitsLoading = false;
        state.error = action.payload;
      });

    // Create unit
    builder
      .addCase(createCustomUnit.pending, (state) => {
        state.unitsLoading = true;
        state.error = null;
      })
      .addCase(createCustomUnit.fulfilled, (state, action) => {
        state.unitsLoading = false;
        state.units.customUnits.push(action.payload);
        const nameLower = action.payload.name.toLowerCase();
        if (!state.units.allUnits.includes(nameLower)) {
          state.units.allUnits.push(nameLower);
          state.units.allUnits.sort();
        }
        state.success = true;
        state.successMessage = 'Unit created successfully';
      })
      .addCase(createCustomUnit.rejected, (state, action) => {
        state.unitsLoading = false;
        state.error = action.payload;
      });

    // Delete unit
    builder
      .addCase(deleteCustomUnit.pending, (state) => {
        state.unitsLoading = true;
        state.error = null;
      })
      .addCase(deleteCustomUnit.fulfilled, (state, action) => {
        state.unitsLoading = false;
        const deletedUnit = state.units.customUnits.find(u => u.id === action.payload);
        state.units.customUnits = state.units.customUnits.filter(u => u.id !== action.payload);
        if (deletedUnit) {
          const nameLower = deletedUnit.name.toLowerCase();
          state.units.allUnits = state.units.allUnits.filter(u => u !== nameLower);
        }
        state.success = true;
        state.successMessage = 'Unit deleted successfully';
      })
      .addCase(deleteCustomUnit.rejected, (state, action) => {
        state.unitsLoading = false;
        state.error = action.payload;
      });
  },
});

export const { clearError, clearSuccess } = productSlice.actions;
export default productSlice.reducer;
