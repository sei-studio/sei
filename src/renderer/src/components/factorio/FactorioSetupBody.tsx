/**
 * FactorioSetupBody (261113): the Factorio body of the generic setup modal
 * (registered through lib/gameSetupBodies). The modal keeps the pending
 * summon and resumes it when the game loads; the body is the same numbered
 * step list the launch panel's window shows (FactorioSteps).
 */
import React from 'react';
import { useT } from '../../lib/i18n';
import { FactorioSteps } from './FactorioSteps';
import modalStyles from '../LanNotOpenModal.module.css';

export function FactorioSetupBody(): React.ReactElement {
  const t = useT();
  return (
    <>
      <FactorioSteps />
      <p className={modalStyles.hint}>{t('Sei keeps looking while this window is open.')}</p>
    </>
  );
}
