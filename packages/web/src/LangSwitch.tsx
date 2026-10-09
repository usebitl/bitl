import { LANG_LABEL, LANGS, setLang, t, useLang } from './i18n';

/** 한국어 / English 전환. 고른 언어는 이 브라우저에 기억한다 */
export function LangSwitch({ className = '' }: { className?: string }) {
  const lang = useLang();
  return (
    <div role="group" aria-label={t('common.lang')} className={`inline-flex overflow-hidden rounded-lg border border-zinc-300 text-xs dark:border-zinc-700 ${className}`}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={lang === l}
          onClick={() => setLang(l)}
          className={`px-2.5 py-1 ${lang === l ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'}`}
        >
          {LANG_LABEL[l]}
        </button>
      ))}
    </div>
  );
}
