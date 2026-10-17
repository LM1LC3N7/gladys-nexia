// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { BRANDS } from './constants.js';

export const LANGUAGES = Object.freeze(['fr', 'en']);
export const BRAND_KEYS = Object.freeze(Object.keys(BRANDS));

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  brand: 'nexia',
  allow_control: false,
  language: 'fr',
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const bool = (value, fallback) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
};

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const brand = BRAND_KEYS.includes(text(raw.brand)) ? text(raw.brand) : DEFAULTS.brand;
  const email = text(raw.email);
  // The password is sent as typed (spaces included), never trimmed.
  const password = typeof raw.password === 'string' ? raw.password : '';
  const missing = [];
  if (!email) missing.push('email');
  if (!password) missing.push('password');
  const language = LANGUAGES.includes(String(raw.language))
    ? String(raw.language)
    : DEFAULTS.language;
  return {
    brand,
    email,
    password,
    missing,
    // An address without "@" is surely a typo: said to the user, never sent.
    emailInvalid: email !== '' && !/^[^\s@]+@[^\s@]+$/.test(email),
    allowControl: bool(raw.allow_control, DEFAULTS.allow_control),
    language,
  };
}

/** What a credential refusal is about (in memory only, never logged). */
export const credentialsKey = (config) =>
  JSON.stringify([config.brand, config.email.toLowerCase(), config.password]);

/**
 * The account a refusal or a pause persisted in /data belongs to: a hash of
 * the brand and the e-mail, never the password, never the address itself.
 */
export const accountKey = (config) =>
  createHash('sha256')
    .update(`${config.brand}\n${config.email.toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
