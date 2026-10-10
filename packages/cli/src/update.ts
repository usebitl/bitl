import { checkCliUpdate } from '@bitl/shared/node';
import { t } from './i18n.js';

/**
 * New-version notice: one line after a command the user typed (status, install, start …).
 * The check itself (npm registry once a day, 1 second timeout, BITL_NO_UPDATE_CHECK=1) is @bitl/shared/node checkCliUpdate.
 * Never called from hook/adapter paths — must not slow the agent.
 */
export async function updateNotice(current = process.env.BITL_CLIENT_VERSION): Promise<string | undefined> {
  const u = await checkCliUpdate(current);
  return u && `${t('update.available', { ...u })}\n${t('update.changelog')}`;
}
