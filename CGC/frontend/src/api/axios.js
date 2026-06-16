import axios from 'axios';

const api = axios.create({
  baseURL: 'https://cambridge-garden-centre-production-99b9.up.railway.app',
  // baseURL: 'http://localhost:4000'
});


api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

export default api;
