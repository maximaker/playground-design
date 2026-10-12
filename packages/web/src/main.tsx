import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './kit-tokens.css';
import './kit-topbar.css';
import './styles.css';
import { wireSwitcher } from './ui/switcher.ts';

// Esc and an outside click close the app switcher everywhere.
wireSwitcher();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
