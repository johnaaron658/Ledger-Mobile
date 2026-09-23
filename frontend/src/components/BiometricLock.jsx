import { useEffect, useState } from 'react';
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

export default function BiometricLock({ children }) {
  // null = still deciding (checking availability + the saved toggle);
  // false = no lock configured/available, render the app; true = locked,
  // show the unlock screen.
  const [locked, setLocked] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isLocalEngine || !isNativePlatform()) {
      // Desktop/web builds have no biometric concept, and the plugin's own
      // web fallback reports unavailable anyway — skip straight to unlocked
      // rather than making every `npm run dev` session pass through here.
      setLocked(false);
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
    })();
  }, []);

  // Re-lock on backgrounding (§6 item 7): a lock that only engages at app
  // launch and never again would leave the app unlocked for the rest of the
  // OS session once opened once — the point of a lock on a finance app is
  // that picking the phone up mid-session still requires it.
  useEffect(() => {
    if (!enabled) return undefined;
    return onAppStateChange({ onBackground: () => setLocked(true) });
  }, [enabled]);

  const unlock = async () => {
    setAuthenticating(true);
    setError(null);
    try {
      await authenticateBiometric('Unlock Ledger Dashboard');
      setLocked(false);
    } catch (e) {
      setError(e?.message || 'Authentication failed or was canceled.');
    } finally {
      setAuthenticating(false);
    }
  };

  if (locked === null) return null; // avoid a flash of unlocked content while deciding
  if (!locked) return children;

  return (
    <div className="app">
      <div className="biometric-lock-screen">
        <h2>Locked</h2>
        <p className="muted">Ledger Dashboard is locked with biometric authentication.</p>
        {error && <div className="error-banner">{error}</div>}
        <button className="btn btn-primary" onClick={unlock} disabled={authenticating}>
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
      Lock with biometrics
    </label>
  );
}
