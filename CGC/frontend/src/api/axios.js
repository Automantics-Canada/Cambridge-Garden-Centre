import axios from 'axios';
import { API_BASE_URL } from '../lib/apiBase';
import { clearStoredSession, setSessionNotice } from '../lib/session';

const api = axios.create({
  baseURL: API_BASE_URL,
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

/** The endpoints whose own 401 is an answer, not an expired session. */
function isAuthEndpoint(url) {
  return typeof url === 'string' && url.includes('/api/auth/');
}

/**
 * A 401 on any authenticated read means the stored token is no longer good —
 * expired, revoked, or signed with a secret the server has since rotated. There
 * is no refresh token to spend, so the only honest response is to end the
 * session and ask for a fresh sign-in.
 *
 * Without this the app kept a dead token forever: the shell rendered from the
 * cached user object while every screen showed "server returned 401", which
 * reads to a user as the server being down.
 *
 * A 401 from the login route itself is left alone — that is "wrong password",
 * and bouncing the login page back to itself would just hide the message.
 */
export function endSessionOnUnauthorized(error) {
  const status = error?.response?.status;
  if (status !== 401 || isAuthEndpoint(error?.config?.url)) return;

  clearStoredSession();
  setSessionNotice('Your session expired. Please sign in again.');

  const { pathname, search } = window.location;
  if (pathname.startsWith('/login')) return;
  window.location.replace(`/login?next=${encodeURIComponent(`${pathname}${search}`)}`);
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    endSessionOnUnauthorized(error);
    return Promise.reject(error);
  }
);

export default api;
