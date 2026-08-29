import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../api/axios';
import { clearStoredSession, readStoredSession } from '../lib/session';

// Reads the stored session and drops it if the token has already expired, so a
// stale token can no longer boot the app into a signed-in shell that 401s on
// every read. See `lib/session.js`.
const { user: savedUser, token: savedToken } = readStoredSession();

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
      const response = await api.post('/api/auth/login', { email, password });
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
      const response = await api.post('/api/auth/register', { email, password, name, role });
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
      clearStoredSession();
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
        const { token, user } = action.payload;
        
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
