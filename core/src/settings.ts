// Port of backend/app/app_settings.py.

import type { Storage } from "./store.js";

export interface AppSettings {
  default_currency: string;
  main_commodity: string;
}

// Mirrors config.py's REPORT_CURRENCY default ("PHP") — there's no env here,
// so the seed value is just hardcoded; from then on it's runtime state same
// as the Python side.
const DEFAULTS: AppSettings = { default_currency: "₱", main_commodity: "PHP" };

export async function getSettings(storage: Storage): Promise<AppSettings> {
  const stored = (await storage.readConfig("app_settings")) as Partial<AppSettings> | null;
  return { ...DEFAULTS, ...stored };
}

export async function updateSettings(storage: Storage, payload: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings(storage);
  const settings: AppSettings = {
    default_currency: payload.default_currency || current.default_currency,
    main_commodity: payload.main_commodity || current.main_commodity,
  };
  await storage.writeConfig("app_settings", settings);
  return settings;
}

export async function getMainCommodity(storage: Storage): Promise<string> {
  return (await getSettings(storage)).main_commodity;
}

export async function getDefaultCurrency(storage: Storage): Promise<string> {
  return (await getSettings(storage)).default_currency;
}

/** Port of app_settings.get_report_currency_aliases: both settings name the
 * same real-world reporting currency (main_commodity is the valuation
 * target, default_currency is what's written onto new entries), so both
 * count — see engine's isReportCurrency, which takes this set as a param. */
export async function getReportCurrencyAliases(storage: Storage): Promise<Set<string>> {
  const settings = await getSettings(storage);
  return new Set([settings.main_commodity, settings.default_currency].filter(Boolean).map((c) => c.toUpperCase()));
}
