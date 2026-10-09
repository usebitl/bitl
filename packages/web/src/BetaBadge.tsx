import { t } from './i18n';

/** 베타 기간 표시 — 로고 옆. 정식 출시(요금제 켬) 때 이 파일을 쓰는 곳을 지운다 */
export function BetaBadge() {
  return (
    <span className="rounded-full border border-emerald-500/50 px-1.5 py-px text-[0.65rem] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
      {t('common.beta')}
    </span>
  );
}
