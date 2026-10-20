import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './ui/ErrorBoundary.tsx';
import './kit-tokens.css';
import './kit-topbar.css';
import './styles.css';
import './kit-tempo.css';
import './tempo-playground.css';
import { wireSwitcher } from './ui/switcher.ts';

// Esc and an outside click close the app switcher everywhere.
wireSwitcher();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
