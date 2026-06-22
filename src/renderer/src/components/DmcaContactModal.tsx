/**
 * DmcaContactModal — published in SettingsScreen → Legal panel as "Report
 * copyright infringement (DMCA)".
 *
 * §512(c)(2) requires the Designated Agent's full name, mailing address,
 * phone, and email to live on the website at a public URL. The terms.html
 * page at sei.gg/terms publishes them; this in-app modal intentionally
 * shows only the email + a link to the public USCO directory listing,
 * which keeps the operator's home address out of the shipped app binary.
 * Users with copyright complaints get the agent email here AND can reach
 * the full statutory disclosure via either link.
 */

import React, { useEffect } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import styles from './DmcaContactModal.module.css';

const AGENT_EMAIL = 'dmca@sei.gg';
const DIRECTORY_LISTING_URL =
  'https://dmca.copyright.gov/dmca/home/publish/history.html?id=5ab88506aaeea571efbc2d84e08bcd3b';
const TERMS_URL = 'https://sei.gg/terms.html#dmca';

export interface DmcaContactModalProps {
  /** Closes the modal. Caller controls mount/unmount. */
  onClose: () => void;
}

export function DmcaContactModal({ onClose }: DmcaContactModalProps): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openDirectory = (): void => {
    void sei.openExternal(DIRECTORY_LISTING_URL);
  };
  const emailAgent = (): void => {
    void sei.openExternal(`mailto:${AGENT_EMAIL}`);
  };

  const titleId = 'dmca-contact-title';

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 id={titleId} className={styles.title}>
          DMCA Designated Agent
        </h2>
        <p className={styles.lede}>
          To report copyright infringement on a Sei companion, send a written DMCA notice to our
          designated agent at:
        </p>
        <p className={styles.email}>
          <a
            href={`mailto:${AGENT_EMAIL}`}
            onClick={(e) => {
              e.preventDefault();
              emailAgent();
            }}
          >
            {AGENT_EMAIL}
          </a>
        </p>
        <p className={styles.note}>
          Our agent&apos;s full statutory contact details (name, mailing address, phone) are
          published in the public US Copyright Office Designated Agent Directory and on our Terms
          of Service page.
        </p>
        <div className={styles.footer}>
          <Button kind="ghost" size="md" onClick={openDirectory}>
            Open USCO Directory listing
          </Button>
          <Button
            kind="ghost"
            size="md"
            onClick={() => void sei.openExternal(TERMS_URL)}
          >
            Open Terms §7
          </Button>
          <Button kind="accent" size="md" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
