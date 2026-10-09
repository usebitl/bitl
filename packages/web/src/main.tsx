import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Board } from './Board';
import { useLang } from './i18n';
import './index.css';
import { registerServiceWorker } from './pwa';
import { useContentKeys } from './useSessions';

registerServiceWorker();

/** 로컬 모드 (bitl start): 이 PC 의 보드. 카드 내용은 bitl pair 링크로 받은 키로 이 브라우저가 푼다 */
function Root() {
  useLang(); // 언어가 바뀌면 전체를 새 언어로 다시 그린다
  return <Board keys={useContentKeys()} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
