// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. The connection status and the button answer
// are { en, fr }; errors thrown to Gladys are English (one language per
// message, like the core's); the device texts (names, option labels) follow
// the language chosen in the configuration.
// -----------------------------------------------------------------------------

import { CODES } from './nexia/errors.js';

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const plural = (n, one, many) => (n === 1 ? one : many);

/** A wait in words: minutes, or hours past two hours. */
function wait(ms) {
  if (ms >= 2 * 3600_000) {
    const hours = Math.round(ms / 3600_000);
    return { en: `${hours} h`, fr: `${hours} h` };
  }
  return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
}

/** Why the cloud failed, in a few words (codes and statuses only). */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.NETWORK:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
    case CODES.DEADLINE:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.SESSION:
      return { en: 'session refused', fr: 'session refusée' };
    case CODES.RATE_LIMITED:
      return { en: 'too many requests', fr: 'trop de requêtes' };
    case CODES.BAD_URL:
      return { en: 'unexpected address', fr: 'adresse inattendue' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

const RETRY = (delay) => ({
  en: `Retried in ${wait(delay).en}.`,
  fr: `Nouvel essai dans ${wait(delay).fr}.`,
});

const join = (...parts) => ({
  en: parts
    .map((p) => p.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p.fr)
    .filter(Boolean)
    .join(' '),
});

export const T = {
  status: {
    notConfigured: {
      en: 'Choose the brand, type the e-mail address and the password of your Nexia / Trane Home / American Standard Home account, then save.',
      fr: 'Choisissez la marque, saisissez l’adresse e-mail et le mot de passe de votre compte Nexia / Trane Home / American Standard Home, puis enregistrez.',
    },
    emailInvalid: {
      en: 'The e-mail address does not look valid: type the one you sign in to the app with.',
      fr: 'L’adresse e-mail ne semble pas valide : saisissez celle de la connexion à l’application.',
    },
    connecting: { en: 'Signing in to the cloud...', fr: 'Connexion au cloud…' },
    ok: ({ thermostats, zones, offline }) =>
      join(
        {
          en: `Connected: ${thermostats} ${plural(thermostats, 'thermostat', 'thermostats')}, ${zones} ${plural(zones, 'zone', 'zones')}.`,
          fr: `Connecté : ${thermostats} ${plural(thermostats, 'thermostat', 'thermostats')}, ${zones} ${plural(zones, 'zone', 'zones')}.`,
        },
        offline > 0
          ? {
              en: `${offline} ${plural(offline, 'thermostat is', 'thermostats are')} offline for the cloud.`,
              fr: `${offline} ${plural(offline, 'thermostat est hors ligne', 'thermostats sont hors ligne')} pour le cloud.`,
            }
          : {},
      ),
    noThermostat: {
      en: 'Connected, but the house of this account has no thermostat Gladys can show (see the logs).',
      fr: 'Connecté, mais la maison de ce compte n’a aucun thermostat que Gladys sait afficher (voir les journaux).',
    },
    refusedRecently: (delay) => ({
      en: `The cloud refused the e-mail address or the password moments ago: Gladys signs in again in ${Math.max(1, Math.ceil(delay / 1000))} s (at most once a minute, so that the account is not locked).`,
      fr: `Le cloud a refusé l’adresse e-mail ou le mot de passe il y a un instant : Gladys se reconnecte dans ${Math.max(1, Math.ceil(delay / 1000))} s (au plus une fois par minute, pour ne pas bloquer le compte).`,
    }),
    loginWait: (delay) =>
      join(
        {
          en: 'Gladys waits before signing in again (sign-ins are spaced out so that the account is not locked).',
          fr: 'Gladys attend avant de se reconnecter (les connexions sont espacées pour ne pas bloquer le compte).',
        },
        RETRY(delay),
      ),
    refused: (nextIn, left = 1) =>
      nextIn === null
        ? {
            en: 'The cloud refused the e-mail address or the password. Gladys does not try again by itself (repeated failures may lock the account): fix them and save, or press "Test the connection".',
            fr: 'Le cloud a refusé l’adresse e-mail ou le mot de passe. Gladys ne réessaie plus seul (des échecs répétés peuvent bloquer le compte) : corrigez-les et enregistrez, ou appuyez sur « Tester la connexion ».',
          }
        : {
            en: `The cloud refused the e-mail address or the password. Gladys tries again by itself in ${wait(nextIn).en} (${left} automatic ${plural(left, 'try', 'tries')} left), then stops: fix them and save, or press "Test the connection".`,
            fr: `Le cloud a refusé l’adresse e-mail ou le mot de passe. Gladys réessaie seul dans ${wait(nextIn).fr} (${left} ${plural(left, 'essai automatique restant', 'essais automatiques restants')}), puis s’arrête : corrigez-les et enregistrez, ou appuyez sur « Tester la connexion ».`,
          },
    session: (delay) =>
      join(
        {
          en: 'The cloud refused the session just after signing in: Gladys waits before signing in again.',
          fr: 'Le cloud a refusé la session juste après la connexion : Gladys attend avant de se reconnecter.',
        },
        RETRY(delay),
      ),
    busy: (delay) =>
      join(
        {
          en: 'The cloud asks Gladys to slow down (HTTP 429): every request is paused.',
          fr: 'Le cloud demande à Gladys de ralentir (HTTP 429) : toutes les requêtes sont suspendues.',
        },
        RETRY(delay),
      ),
    unreachable: (err, delay) =>
      join(
        { en: 'The cloud does not answer:', fr: 'Le cloud ne répond pas :' },
        reasonOf(err),
        { en: '—', fr: '—' },
        RETRY(delay),
      ),
  },
  badge: {
    offline: {
      en: 'The cloud reports this thermostat offline',
      fr: 'Le cloud signale ce thermostat hors ligne',
    },
  },
  test: {
    ok: ({ house, thermostats, zones }) => ({
      en: `Connected${house ? ` to "${house}"` : ''}: ${thermostats} ${plural(thermostats, 'thermostat', 'thermostats')}, ${zones} ${plural(zones, 'zone', 'zones')}.`,
      fr: `Connecté${house ? ` à « ${house} »` : ''} : ${thermostats} ${plural(thermostats, 'thermostat', 'thermostats')}, ${zones} ${plural(zones, 'zone', 'zones')}.`,
    }),
  },
  errors: {
    unknownFeature: 'Unknown device or feature: scan the devices again',
    readOnly: 'This feature is read only',
    notConnected: 'The cloud is not connected: see the configuration of the integration',
    controlDisabled:
      'Commands are off: allow them first in the configuration of the integration ("Allow commands")',
    invalidSetpoint: (min, max, unit) =>
      `Invalid setpoint: a temperature from ${min} to ${max} ${unit} expected`,
    outOfLimits: (what, min, max, unit) =>
      `The ${what} setpoint must stay from ${min} to ${max} ${unit} on this thermostat: nothing was sent`,
    deadband: (deadband, unit) =>
      `The heating and cooling setpoints must stay ${deadband} ${unit} apart on this thermostat: nothing was sent`,
    unknownLimits:
      'The setpoint limits or the deadband of this thermostat are unknown: nothing was sent',
    invalidMode: 'This zone does not offer this mode',
    invalidFanMode: 'This thermostat does not offer this fan mode',
    offline: 'The cloud reports this thermostat offline: nothing was sent',
    unknownUnit:
      'The temperature unit of this feature does not match the thermostat: scan the devices again',
    tooSlow:
      'The command could not be checked in time (Gladys waits 5 s for its answer): nothing was sent, try again',
    unknownState: (err) =>
      `The current state could not be read (${reasonOf(err).en}): nothing was sent`,
    gone: 'This thermostat or zone is no longer in the house: nothing was sent',
    notSent: (err) =>
      `The command could not reach the cloud (${reasonOf(err).en}): nothing was sent`,
    refused: (err) => `The cloud refused the command (${reasonOf(err).en})`,
    inFlight:
      'The previous command is still being applied by the cloud: nothing was sent, try again in a few seconds / ' +
      'La commande précédente est encore en cours dans le cloud : rien n’a été envoyé, réessayez dans quelques secondes',
    maybeNotSent:
      'The connection to the cloud dropped: the command may not have reached it; the thermostat is read again in a few seconds',
    configChanged: 'The configuration changed meanwhile: nothing was sent, try again',
    busy: 'The cloud asked Gladys to slow down: nothing was sent, try again later',
    testTooLong:
      'The cloud has not answered yet: see the connection status in a moment (nothing else to do)',
  },
};

const DEVICE_TEXTS = {
  fr: {
    thermostat: (name) => `${name} (système)`,
    zone: (name) => name,
    features: {
      humidity: 'Humidité',
      'outdoor-temperature': 'Température extérieure',
      'system-status': 'État du système',
      'fan-mode': 'Ventilation',
      'humidify-setpoint': 'Consigne d’humidification (%)',
      'dehumidify-setpoint': 'Consigne de déshumidification (%)',
      temperature: 'Température',
      'heat-setpoint': 'Consigne de chauffage',
      'cool-setpoint': 'Consigne de refroidissement',
      mode: 'Mode',
      'operating-state': 'Fonctionnement',
      'setpoint-status': 'Programme / maintien',
    },
    modes: { OFF: 'Arrêt', HEAT: 'Chauffage', COOL: 'Refroidissement', AUTO: 'Auto' },
    fan: { auto: 'Auto', on: 'Marche', circulate: 'Circulation' },
  },
  en: {
    thermostat: (name) => `${name} (system)`,
    zone: (name) => name,
    features: {
      humidity: 'Humidity',
      'outdoor-temperature': 'Outdoor temperature',
      'system-status': 'System status',
      'fan-mode': 'Fan mode',
      'humidify-setpoint': 'Humidify setpoint (%)',
      'dehumidify-setpoint': 'Dehumidify setpoint (%)',
      temperature: 'Temperature',
      'heat-setpoint': 'Heating setpoint',
      'cool-setpoint': 'Cooling setpoint',
      mode: 'Mode',
      'operating-state': 'Operating state',
      'setpoint-status': 'Schedule / hold',
    },
    modes: { OFF: 'Off', HEAT: 'Heating', COOL: 'Cooling', AUTO: 'Auto' },
    fan: { auto: 'Auto', on: 'On', circulate: 'Circulate' },
  },
};

export const texts = (language) => DEVICE_TEXTS[language] ?? DEVICE_TEXTS.fr;
