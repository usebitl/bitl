import { defineConfig } from 'vite';

/**
 * 서비스 워커 빌드 → dist/sw.js (앱 빌드 다음에 실행, dist 를 비우지 않는다).
 * 해시 없는 고정 이름이어야 브라우저가 같은 워커의 새 버전으로 알아본다.
 * 모든 브라우저가 모듈 워커를 지원하지는 않아 하나의 파일(IIFE)로 묶는다.
 */
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  build: {
    emptyOutDir: false,
    copyPublicDir: false,
    lib: { entry: 'sw/sw.ts', formats: ['iife'], name: 'bitlsw', fileName: () => 'sw.js' },
  },
});
