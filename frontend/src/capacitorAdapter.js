// Phase 5 native-bridge glue (MOBILE_APP_IMPLEMENTATION.md §6 items 1-4, 7).
// Centralizes every Capacitor plugin call the app makes, so api.js and the
// components stay plugin-API-agnostic — same reason api.js itself exists as
// a single seam (see App.jsx's header comment / §4.2 of MOBILE_APP.md).
//
// ⚠ UNVERIFIED ON DEVICE. Every function here is written against each
// plugin's documented TypeScript definitions (checked directly against
// node_modules/<plugin>/dist/esm/definitions.d.ts while writing this) and,
// where a plugin ships one, its web fallback — but there is no
// Android/iOS device or emulator in this environment. See
// MOBILE_APP_IMPLEMENTATION.md's Phase 5 writeup for what's confirmed vs.
// not. The web-fallback paths (FilePicker's hidden <input>, Share's
// navigator.share, BiometricAuth's simulated-availability mode) are the
// parts exercised by `npm run build`/`preview` in this environment; the
// native paths are code-reviewed only.

import { Capacitor } from '@capacitor/core';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { App as CapacitorApp } from '@capacitor/app';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';

export function isNativePlatform() {
  return Capacitor.isNativePlatform();
}

// --- base64 <-> text --------------------------------------------------
// FilePicker's native result only provides base64 (`readData: true`); its
// web fallback provides a real Blob instead (see pickJournalFile below).
// atob/TextDecoder are both standard Web APIs available in WKWebView and
// Android's WebView, not just desktop browsers.
function base64ToText(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000; // avoid a giant argument list to String.fromCharCode for a multi-MB journal
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

const PICK_CANCELED_MESSAGE = 'pickFiles canceled.'; // FilePickerWeb.ERROR_PICK_FILE_CANCELED — native cancel is a `null`/no-op resolve instead, see below

/** Opens the platform document picker (native) or a hidden `<input
 * type=file>` (web fallback — FilePicker ships one, so this single call
 * works in both `npm run dev` and inside Capacitor without branching on
 * isNativePlatform()). Swaps Phase 4's raw `<input type="file">` in
 * ImportScreen.jsx (§6 item 2). Returns `null` if the user cancels rather
 * than throwing, so callers don't need to special-case the cancel path. */
export async function pickTextFile({ types }) {
  try {
    const result = await FilePicker.pickFiles({ types, readData: true, limit: 1 });
    const file = result.files?.[0];
    if (!file) return null;
    const text = file.blob ? await file.blob.text() : base64ToText(file.data ?? '');
    return { name: file.name, text };
  } catch (e) {
    if (e?.message === PICK_CANCELED_MESSAGE) return null;
    throw e;
  }
}

/** Same as pickTextFile but returns raw bytes (for the config bundle .zip,
 * which importConfig/importConfigBundle need as a Uint8Array, not text). */
export async function pickBinaryFile({ types }) {
  try {
    const result = await FilePicker.pickFiles({ types, readData: true, limit: 1 });
    const file = result.files?.[0];
    if (!file) return null;
    if (file.blob) return { name: file.name, bytes: new Uint8Array(await file.blob.arrayBuffer()) };
    const binary = atob(file.data ?? '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { name: file.name, bytes };
  } catch (e) {
    if (e?.message === PICK_CANCELED_MESSAGE) return null;
    throw e;
  }
}

const EXPORT_DIR = Directory.Cache; // scratch space for the file the share sheet reads (MOBILE_APP.md §9.2's "hand to the share sheet"); the durable copy lives in app state via core's recordExport, not here

/** Writes `bytes` to a cache file and hands it to the OS share sheet (§6
 * item 3 — "one tap from the main screen", MOBILE_APP.md §9.2). On the web
 * fallback (`@capacitor/share`'s WebPlugin), Share.share() uses
 * `navigator.share()` if available, else throws — there's no file-system
 * write needed there, so this still round-trips a real, if unverified on a
 * touch device, browser share dialog when running `npm run preview`. */
export async function shareBytes(bytes, filename, mimeType = 'application/zip') {
  if (isNativePlatform()) {
    await Filesystem.writeFile({
      path: filename,
      directory: EXPORT_DIR,
      data: bytesToBase64(bytes),
    });
    const { uri } = await Filesystem.getUri({ path: filename, directory: EXPORT_DIR });
    await Share.share({ title: filename, files: [uri], dialogTitle: 'Export ledger backup' });
    return;
  }
  // Web fallback: build a same-origin Blob URL File and hand it to the Web
  // Share API (Level 2, file sharing) if present, otherwise fall back to a
  // plain download so `npm run preview` still produces something usable.
  const file = new File([bytes], filename, { type: mimeType });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: filename });
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Biometric lock (§6 item 7) ----------------------------------------
// Platform API only, no account/login (MOBILE_APP.md §9.2) — this wraps
// @aparajita/capacitor-biometric-auth's checkBiometry()/authenticate(),
// which are themselves thin bridges to LocalAuthentication (iOS) /
// BiometricPrompt (Android). Its own web fallback simulates
// unavailable-by-default, so `isBiometricLockAvailable()` correctly resolves
// false in the browser and the lock screen never engages there.

export async function isBiometricLockAvailable() {
  try {
    const result = await BiometricAuth.checkBiometry();
    return result.isAvailable;
  } catch {
    return false;
  }
}

export async function authenticateBiometric(reason) {
  await BiometricAuth.authenticate({ reason, allowDeviceCredential: true, cancelTitle: 'Cancel' });
}

/** Fires `onBackground`/`onForeground` around app pause/resume — the
 * re-lock trigger for the biometric gate (locking only on launch, with no
 * re-lock on backgrounding, would leave a phone that's picked up mid-session
 * unlocked, defeating the point of a lock on a finance app). Native only;
 * a no-op unsubscribe on web, where there's no pause/resume concept. */
export function onAppStateChange({ onBackground, onForeground } = {}) {
  if (!isNativePlatform()) return () => {};
  let handle;
  CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    if (isActive) onForeground?.();
    else onBackground?.();
  }).then((h) => {
    handle = h;
  });
  return () => handle?.remove();
}
