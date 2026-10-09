// npm 에 낸 bitl CLI(@usebitl/cli) 버전 — 웹의 기기 화면이 작업 PC 의 bitl 이 오래됐는지 알려 준다.
// npm publish 를 마친 뒤에 올리고 배포한다 (먼저 올리면 아직 없는 버전으로 업데이트하라고 안내하게 된다).
// cli/npm/package.json 의 version 과 같아야 한다 — test/release.test.ts 가 확인.

/** 지금 npm 의 최신 버전 */
export const CLI_LATEST = '0.1.4';

/**
 * 꼭 업데이트해야 하는 버전 (서버 형식 변경·보안 문제). below 보다 낮은 PC 가 있으면 화면 위에 안내한다.
 * from: 그날부터 옛 버전이 작업을 보내지 못한다 (YYYY-MM-DD). 평소에는 undefined.
 */
export const CLI_REQUIRED: { below: string; from: string } | undefined = undefined;

/** "0.1.10" > "0.1.9". 형식이 다르면 NaN 대신 0 으로 본다 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** 작업 PC 의 bitl 상태: 최신 · 업데이트 있음 · 꼭 업데이트 · 알 수 없음(0.1.3 이하는 버전을 알리지 않는다) */
export type CliStatus = 'latest' | 'update' | 'required' | 'unknown';

export function cliStatus(version: string | undefined): CliStatus {
  if (!version || !VERSION_PATTERN.test(version)) return 'unknown';
  if (CLI_REQUIRED && compareVersions(version, CLI_REQUIRED.below) < 0) return 'required';
  return compareVersions(version, CLI_LATEST) < 0 ? 'update' : 'latest';
}
