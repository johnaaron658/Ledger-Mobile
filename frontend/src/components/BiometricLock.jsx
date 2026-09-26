import { useEffect, useRef, useState } from 'react';
import { api, isLocalEngine } from '../api';
import { authenticateBiometric, isBiometricLockAvailable, isNativePlatform, onAppStateChange } from '../capacitorAdapter';

// Phase 5 §6 item 7 / MOBILE_APP.md §9.2: "Biometric lock, if added, uses
// the platform API only — no account, no login." This gate wraps the whole
// app (see App.jsx): while locked, it renders nothing else, so a stolen or
// borrowed phone can't read the journal without also passing Face
// ID/fingerprint/device-credential. The toggle itself (on/off, since not
// everyone wants a lock screen on top of their own phone's own lock) is
// stored via api.writeState (core/src/mobileState.ts's device-local `state`
// keys) — deliberately NOT part of the config bundle (§3.2): a lock
// preference is meaningless once restored onto a different device or the
// desktop oracle, so it must never round-trip through export/import.

const LOCK_ENABLED_KEY = 'biometric_lock_enabled';

// A quick hop to another app (copying an amount, checking a message) and
// straight back shouldn't demand a fresh unlock mid-entry; only an absence
// longer than this re-locks. Short enough that a phone left unattended
// still locks well before anyone else could pick it up and browse.
const RELOCK_GRACE_MS = 30_000;

export default function BiometricLock({ children }) {
  // null = still deciding (checking availability + the saved toggle);
  // false = no lock configured/available, render the app; true = locked,
  // show the unlock screen.
  const [locked, setLocked] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [error, setError] = useState(null);
  // Once unlocked, the app stays mounted (just hidden) across re-locks, so
  // its in-memory state — current tab, a half-typed Quick add posting —
  // survives backgrounding. Before the first unlock nothing is mounted at
  // all, so a locked launch never loads the journal.
  const [unlockedOnce, setUnlockedOnce] = useState(false);
  const backgroundedAt = useRef(null);

  useEffect(() => {
    if (!isLocalEngine || !isNativePlatform()) {
      // Desktop/web builds have no biometric concept, and the plugin's own
      // web fallback reports unavailable anyway — skip straight to unlocked
      // rather than making every `npm run dev` session pass through here.
      setLocked(false);
      setUnlockedOnce(true);
      return;
    }
    (async () => {
      const [isAvailable, savedEnabled] = await Promise.all([
        isBiometricLockAvailable(),
        api.readAppState ? api.readAppState(LOCK_ENABLED_KEY) : null,
      ]);
      const wantsLock = isAvailable && !!savedEnabled;
      setEnabled(wantsLock);
      setLocked(wantsLock);
      if (!wantsLock) setUnlockedOnce(true);
    })();
  }, []);

  // Re-lock on backgrounding (§6 item 7): a lock that only engages at app
  // launch and never again would leave the app unlocked for the rest of the
  // OS session once opened once — the point of a lock on a finance app is
  // that picking the phone up mid-session still requires it. Timed on
  // resume against RELOCK_GRACE_MS rather than locking the instant it
  // backgrounds.
  useEffect(() => {
    if (!enabled) return undefined;
    return onAppStateChange({
      onBackground: () => {
        backgroundedAt.current = Date.now();
      },
      onForeground: () => {
        const since = backgroundedAt.current;
        backgroundedAt.current = null;
        if (since !== null && Date.now() - since > RELOCK_GRACE_MS) setLocked(true);
      },
    });
  }, [enabled]);

  const unlock = async () => {
    setAuthenticating(true);
    setError(null);
    try {
      await authenticateBiometric('Unlock Ledger Dashboard');
      setLocked(false);
      setUnlockedOnce(true);
    } catch (e) {
      setError(e?.message || 'Authentication failed or was canceled.');
    } finally {
      setAuthenticating(false);
    }
  };

  if (locked === null) return null; // avoid a flash of unlocked content while deciding

  // The wrapper element must stay the same across lock/unlock (only its
  // `hidden` flips) or React would remount the app and drop its state.
  // `display: contents` keeps it out of the layout while unlocked.
  return (
    <>
      {unlockedOnce && (
        <div hidden={!!locked} style={locked ? undefined : { display: 'contents' }}>
          {children}
        </div>
      )}
      {locked && <LockScreen error={error} authenticating={authenticating} onUnlock={unlock} />}
    </>
  );
}

function LockScreen({ error, authenticating, onUnlock }) {
  return (
    <div className="app">
      <div className="biometric-lock-screen">
        <h2>Locked</h2>
        <p className="muted">Ledger Dashboard is locked with biometric authentication.</p>
        {error && <div className="error-banner">{error}</div>}
        <button className="btn btn-primary" onClick={onUnlock} disabled={authenticating}>
          {authenticating ? 'Waiting…' : 'Unlock'}
        </button>
      </div>
    </div>
  );
}

/** Exported for a Settings toggle to call (there's no dedicated Settings tab
 * in this app today — CommoditiesView/App.jsx's currency inputs are the
 * closest thing — so this is wired directly where useful rather than adding
 * a new tab as part of this phase). `enable` also re-checks availability so
 * a caller can't enable a lock the device can't actually satisfy. */
export async function setBiometricLockEnabled(enable) {
  if (enable && !(await isBiometricLockAvailable())) {
    throw new Error('No biometric authentication is available on this device.');
  }
  if (api.writeAppState) await api.writeAppState(LOCK_ENABLED_KEY, enable);
}

export { LOCK_ENABLED_KEY };

/** Header-bar toggle (App.jsx, next to ExportBar) — renders nothing on
 * desktop/web or on a device with no enrolled biometry, so it never shows a
 * control the app can't actually honor. */
export function BiometricToggle() {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isLocalEngine || !isNativePlatform()) return;
    (async () => {
      const isAvailable = await isBiometricLockAvailable();
      setAvailable(isAvailable);
      if (isAvailable && api.readAppState) setEnabled(!!(await api.readAppState(LOCK_ENABLED_KEY)));
    })();
  }, []);

  if (!available) return null;

  const toggle = async () => {
    setError(null);
    const next = !enabled;
    try {
      await setBiometricLockEnabled(next);
      setEnabled(next);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <label className="biometric-toggle" title={error ?? ''}>
      <input type="checkbox" checked={enabled} onChange={toggle} />
      <span className="biometric-text-long">Lock with biometrics</span>
      <span className="biometric-text-short">Lock</span>
    </label>
  );
}
