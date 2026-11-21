/**
 * The VRM licence line (261122, experimental): who made the model and what
 * its VRM meta allows, read at import (manifest.vrm). Shown, never enforced.
 * Plain text only: every value is the author's own string or a closed enum.
 */
import React from 'react';
import type { AvatarVrmInfo } from '@shared/ipc';
import { useT } from '../../lib/i18n';

export function VrmLicenseNote({ info, name, className }: { info: AvatarVrmInfo; name: string; className?: string }): React.ReactElement {
  const t = useT();
  const who =
    info.avatarPermission === 'everyone'
      ? t('Everyone')
      : info.avatarPermission === 'onlyAuthor'
        ? t('Only the author')
        : info.avatarPermission === 'onlySeparatelyLicensedPerson'
          ? t('Licensed people')
          : t('Not stated');
  const what =
    info.commercialUsage === 'personalNonProfit'
      ? t('Personal, non-profit')
      : info.commercialUsage === 'personalProfit'
        ? t('Personal, for profit')
        : info.commercialUsage === 'corporation'
          ? t('Companies too')
          : t('Not stated');
  const share = info.redistribution === true ? t('Allowed') : info.redistribution === false ? t('Not allowed') : t('Not stated');
  const author = info.authors.join(', ');
  return (
    <p className={className} data-vrm-license={info.specVersion}>
      {author ? t('{name} by {author}', { name, author }) : name} (VRM {info.specVersion})
      <br />
      {t('Who may use it: {who}. Commercial use: {what}. Redistribution: {share}.', { who, what, share })}
    </p>
  );
}
