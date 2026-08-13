import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux';
import { Toaster } from 'react-hot-toast';
import { store } from './store/index.js';
import './index.css'
import App from './App.jsx'
import { applyTheme, getStoredTheme } from './lib/theme';

// Apply the saved theme before React paints, so a dark-mode user never sees
// a white flash on load.
applyTheme(getStoredTheme());

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Provider store={store}>
      <Toaster
        position="top-right"
        reverseOrder={false}
        gutter={8}
        toastOptions={{
          duration: 4000,
          style: {
            background: 'rgb(var(--c-surface))',
            color: 'rgb(var(--c-ink))',
            border: '1px solid rgb(var(--c-line))',
            borderRadius: 'var(--r-control)',
            fontFamily: "'Outfit', sans-serif",
            fontSize: '14px',
          },
        }}
      />
      <App />
    </Provider>
  </StrictMode>,
)
