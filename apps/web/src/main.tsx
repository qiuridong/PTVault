import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './app/App.js';
import { Providers } from './app/Providers.js';
import './styles/theme.css';
import { bootstrapTheme } from './theme/theme.js';

const container = document.getElementById('root');
if (!container) throw new Error('Application root is missing');

bootstrapTheme();

createRoot(container).render(
  <StrictMode>
    <Providers>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Providers>
  </StrictMode>,
);
