import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { migrateLegacyStorageKeysToV4 } from './platform/storageMigration';
import 'katex/dist/katex.min.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
migrateLegacyStorageKeysToV4();
createRoot(root).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
