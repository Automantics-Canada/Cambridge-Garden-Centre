import { configureStore } from '@reduxjs/toolkit';
import authReducer from './authSlice';
import supplierReducer from './supplierSlice';
import productReducer from './productSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    suppliers: supplierReducer,
    products: productReducer,
  },
});
