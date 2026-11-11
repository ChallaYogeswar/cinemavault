import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { Providers } from './app/providers';
import { startPwa } from './pwa/startPwa';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

createRoot(root).render(
  <StrictMode>
    <Providers />
  </StrictMode>,
);

startPwa();
