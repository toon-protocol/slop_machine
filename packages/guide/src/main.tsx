import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app';
import '@/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('the guide has no #root element to mount on');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
