import axios from 'axios';
import { API_BASE_URL } from '../lib/apiBase';

const api = axios.create({
  baseURL: API_BASE_URL || 'http://localhost:4000',
});


api.interceptors.request.use(
  (config) => { 
    const token = localStorage.getItem('token');
    const hasExplicitAuthorization = config.headers && typeof config.headers.get === 'function'
      ? Boolean(config.headers.get('Authorization'))
      : Boolean(config.headers?.Authorization);
    if (token && !hasExplicitAuthorization) {
      if (config.headers && typeof config.headers.set === 'function') {
        config.headers.set('Authorization', `Bearer ${token}`);
      } else {
        config.headers = {
          ...config.headers,
          Authorization: `Bearer ${token}`
        };
      }
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

export default api;
