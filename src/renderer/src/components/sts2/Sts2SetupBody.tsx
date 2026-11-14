/**
 * Sts2SetupBody (261115): the Slay the Spire 2 body of the generic setup
 * modal (registered through lib/gameSetupBodies). The modal keeps the
 * pending summon and resumes it when the lobby opens; the body is the same
 * numbered step list the launch panel's window shows (Sts2Steps).
 */
import React from 'react';
import { useT } from '../../lib/i18n';
import { Sts2Steps } from './Sts2Steps';
import modalStyles from '../LanNotOpenModal.module.css';

export function Sts2SetupBody(): React.ReactElement {
  const t = useT();
  return (
    <>
      <Sts2Steps />
      <p className={modalStyles.hint}>{t('Sei keeps looking while this window is open.')}</p>
    </>
  );
}
