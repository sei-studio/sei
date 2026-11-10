/**
 * UserText (profile v3, product call 261110 follow-up): text a creator wrote
 * (a description, a bio) sits in a quiet box, so it reads as quoted user
 * content and never as the app's own words. Every place on the profile that
 * shows creator-written free text renders it through this. Placeholders
 * ("No description yet.") are the app's words and stay outside the box.
 */
import React from 'react';
import styles from './Profile.module.css';

export interface UserTextProps {
  text: string;
  /** Lines shown before it clips (the full text is on hover). */
  lines?: number;
  /** 'lg' for the Overview's reading text; 'md' for a settings row value. */
  size?: 'md' | 'lg';
  className?: string;
  'data-ov'?: string;
}

export function UserText({ text, lines, size = 'md', className, ...rest }: UserTextProps): React.ReactElement {
  return (
    <div
      className={`${styles.userText} ${size === 'lg' ? styles.userTextLg : ''} ${className ?? ''}`}
      data-user-text="true"
      data-ov={rest['data-ov']}
      title={lines ? text : undefined}
    >
      <p className={styles.userTextBody} style={lines ? { WebkitLineClamp: lines } : undefined} data-clamp={lines ? 'true' : undefined}>
        {text}
      </p>
    </div>
  );
}
