/**
 * TerrariaSetupBody (261113): the Terraria body of the generic setup modal
 * (registered through lib/gameSetupBodies). The modal keeps the pending
 * summon and resumes it when the world opens; the body is the same numbered
 * step list the launch panel's window shows (TerrariaSteps).
 */
import React from 'react';
import { useT } from '../../lib/i18n';
import { TerrariaSteps } from './TerrariaSteps';
import modalStyles from '../LanNotOpenModal.module.css';

export function TerrariaSetupBody(): React.ReactElement {
  const t = useT();
  return (
    <>
      <TerrariaSteps />
      <p className={modalStyles.hint}>{t('Sei keeps looking while this window is open.')}</p>
    </>
  );
}
