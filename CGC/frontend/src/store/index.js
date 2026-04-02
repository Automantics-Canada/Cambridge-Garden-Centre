import { configureStore } from '@reduxjs/toolkit';
import authReducer from './authSlice';
import supplierReducer from './supplierSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    suppliers: supplierReducer,
  },
});
