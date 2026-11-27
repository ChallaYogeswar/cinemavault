import './app/zodSetup';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { ErrorBoundary } from './app/ErrorBoundary';
import { installGlobalErrorHandlers } from './app/errorReporter';
import { Providers } from './app/providers';
import { startPwa } from './pwa/startPwa';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

installGlobalErrorHandlers();

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <Providers />
    </ErrorBoundary>
  </StrictMode>,
);

startPwa();
