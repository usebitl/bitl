import { useEffect, useState } from 'react';
import { CopyField } from './Copy';
import { t } from './i18n';
import { UpdateIcon } from './Icons';

/** /api/me .update from the local server (server/src/index.ts watchCliUpdate) */
interface CliUpdate {
  current: string;
  latest: string;
  command: string;
}

const CHANGELOG = 'https://usebitl.com/changelog';
// Closing it hides it for a day; a newer version shows it again
const HIDE_KEY = 'bitl.updateBannerHidden';
const REFRESH_MS = 60 * 60_000;

function hiddenFor(latest: string): boolean {
  try {
    const [version, until] = (localStorage.getItem(HIDE_KEY) ?? '').split('|');
    return version === latest && Date.now() < Number(until);
  } catch {
    return false;
  }
}

function useCliUpdate(): CliUpdate | undefined {
  const [update, setUpdate] = useState<CliUpdate | undefined>(undefined);
  useEffect(() => {
    const load = () =>
      fetch('/api/me')
        .then((r) => r.json() as Promise<{ update?: CliUpdate }>)
        .then((m) => setUpdate(m.update))
        .catch(() => {});
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  return update;
}

/** Local board: a newer bitl is out. Shows the command matching how bitl was installed (npx or npm i -g) */
export function UpdateBanner() {
  const update = useCliUpdate();
  const [hidden, setHidden] = useState<string | null>(null);
  if (!update || hidden === update.latest || hiddenFor(update.latest)) return null;
  const hide = () => {
    try {
      localStorage.setItem(HIDE_KEY, `${update.latest}|${Date.now() + 86_400_000}`);
    } catch {
      // this visit only
    }
    setHidden(update.latest);
  };
  const npx = update.command.startsWith('npx ');
  return (
    // Layout follows this box's width, not the screen's — with the detail panel open the box is narrow
    <div className="@container basis-full">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-amber-500/45 bg-amber-500/10 px-4 py-2.5 text-sm">
        <UpdateIcon className="order-1 size-5 text-amber-600 dark:text-amber-300" />
        <span className="order-2 min-w-0 flex-1 text-amber-800 dark:text-amber-200">
          {t(npx ? 'update.npx' : 'update.global', { latest: update.latest, current: update.current })}{' '}
          <a href={CHANGELOG} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            {t('cli.whatChanged')}
          </a>
        </span>
        <div className="order-4 basis-full @2xl:basis-auto @2xl:w-72">
          <CopyField text={update.command} />
        </div>
        <button
          type="button"
          onClick={hide}
          aria-label={t('cli.hide')}
          title={t('cli.hide')}
          className="order-3 -mr-1 rounded-lg px-2 py-1 text-lg @2xl:order-5 text-amber-700/70 hover:text-amber-900 dark:text-amber-300/70 dark:hover:text-amber-100"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
