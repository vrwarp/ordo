import { DEMO } from '@ordo/client';
import { APP_VERSION } from '@ordo/protocol';
import { useState } from 'react';
import { DemoDialog, resetDemo } from '../../components/DemoBanner.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { t } from '../../i18n/index.ts';
import { thisIsPhone } from '../../lib/layout.ts';
import { logout } from '../../state/session.ts';

/**
 * More (design/28 §2.2; P0's minimum, which P1's `#/more` replaces): which ordo this phone is signed in to, the
 * demo's About and Reset on the Pages demo, the app version, and Sign out at the bottom.
 */
export function MoreSheet({ onClose }: { onClose: () => void }) {
  const [about, setAbout] = useState(false);
  const host = typeof location === 'undefined' ? '' : location.host;
  return (
    <>
      <Dialog
        title={t('more.title')}
        onClose={onClose}
        footer={
          <button type="button" className="compact-wide" data-sign-out onClick={() => void logout()}>
            {t('more.signOut')}
          </button>
        }
      >
        <div className="compact-more">
          <p className="compact-more-venue" data-more-venue>
            {t('more.venue', { host })}
          </p>
          <p className="muted" data-more-signed-in>
            {t(thisIsPhone() ? 'more.signedInPhone' : 'more.signedInDevice')}
          </p>
          {DEMO && (
            <div className="compact-more-demo">
              <button type="button" className="compact-wide" onClick={() => setAbout(true)}>
                {t('more.demoAbout')}
              </button>
              <button
                type="button"
                className="compact-wide danger"
                onClick={() => {
                  onClose();
                  void resetDemo();
                }}
              >
                {t('more.demoReset')}
              </button>
            </div>
          )}
          <p className="muted small" data-more-version>
            {t('more.version', { version: APP_VERSION })}
          </p>
        </div>
      </Dialog>
      {about && <DemoDialog onClose={() => setAbout(false)} />}
    </>
  );
}
