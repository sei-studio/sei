/**
 * DstSetupBody — the Don't Starve Together body of the generic setup modal
 * (game adapters M2, 260908; registered through lib/gameSetupBodies). The
 * modal itself keeps the pending summon and auto-resumes when the world
 * opens; the body is the same numbered step list the launch panel shows
 * (DstSteps, 260909), so a player who pressed Play early sees exactly what
 * the tile showed them, with the one button each step needs.
 */
import React from 'react';
import { useT } from '../../lib/i18n';
import { DstSteps } from './DstSteps';
import modalStyles from '../LanNotOpenModal.module.css';

export function DstSetupBody(): React.ReactElement {
  const t = useT();
  return (
    <>
      <DstSteps />
      <p className={modalStyles.hint}>{t('Sei keeps looking while this window is open.')}</p>
    </>
  );
}
