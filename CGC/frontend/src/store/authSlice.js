import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../api/axios';

const savedUser = JSON.parse(localStorage.getItem('user') || 'null');
const savedToken = localStorage.getItem('token');

const initialState = {
  user: savedUser,
  token: savedToken,
  isAuthenticated: !!savedToken,
  loading: false,
  error: null,
};

export const loginAsync = createAsyncThunk(
  'auth/login',
  async ({ email, password }, { rejectWithValue }) => {
    try {
      const response = await api.post('/auth/login', { email, password });
      return response.data; // expects { token, user: { id, email, name, role } }
    } catch (err) {
      return rejectWithValue(err.response?.data?.error || 'Login Failed');
    }
  }
);

export const registerAsync = createAsyncThunk(
  'auth/register',
  async ({ email, password, name, role }, { rejectWithValue }) => {
    try {
      const response = await api.post('/auth/register', { email, password, name, role });
      return response.data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error || 'Registration Failed');
    }
  }
);

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    logout: (state) => {
      state.user = null;
      state.token = null;
      state.isAuthenticated = false;
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    },
    clearError: (state) => {
      state.error = null;
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(loginAsync.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(loginAsync.fulfilled, (state, action) => {
        state.loading = false;
        state.isAuthenticated = true;
        
        // Handle response mapping. The backend returns user object directly and a token if implemented.
        // Looking at backend auth.controller.ts, AuthService.login(email, password) returns { token, ...user }
        const { token, ...user } = action.payload;
        
        state.user = user;
        state.token = token;
        if (token) localStorage.setItem('token', token);
        if (user) localStorage.setItem('user', JSON.stringify(user));
      })
      .addCase(loginAsync.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });
  },
});

export const { logout, clearError } = authSlice.actions;
export default authSlice.reducer;
