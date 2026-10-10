import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Board } from './Board';
import { useLang } from './i18n';
import './index.css';
import { registerServiceWorker } from './pwa';
import { UpdateBanner } from './UpdateBanner';
import { useContentKeys } from './useSessions';

registerServiceWorker();

/** Local mode (bitl start): this PC's board. This browser decrypts card contents with the key from the bitl pair link */
function Root() {
  useLang(); // re-render everything in the new language when it changes
  return <Board keys={useContentKeys()} banners={<UpdateBanner />} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
