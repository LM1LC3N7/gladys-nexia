# TODO — Nexia / Trane Home / American Standard Home v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own: the claim is in /t/10385 (post #241).

## Status

- [x] **Milestone 1 — core** (2026-10-17): cloud client of the app (sign-in,
      session headers kept between readings, first house, `If-None-Match`,
      one new login on a refused session, at most one every 5 min, doubled
      on a fresh refusal), ported from the nexia library; three brands; one
      device per thermostat (humidity, outdoor temperature, system status,
      fan mode, humidify / dehumidify setpoints) and per zone (temperature,
      heating / cooling setpoints, mode, operating state, schedule / hold);
      °F / °C converted to the unit of each created feature; reading every
      60 s; 429 pause and refusal kept in `/data`; commands off by default
      (setpoints, zone mode, fan mode), fresh read before acting, 3.5 s
      budget, answer at 4.3 s at most; "Test the connection"; docs en/fr;
      cover. Tested with unit tests against the SDK's fake Gladys and a fake
      cloud serving the nexia library's recorded answers. **Never tested
      with a real account.** No Docker on this PC: no e2e test in a
      container.
- [ ] **Milestone 2 — real account** (a tester): record real answers as
      fixtures (e-mail, ids and keys removed), fix what differs. To check
      first:
  - what the cloud answers to a wrong password today (200 + `success:
false`, 401, or a redirect to "forgotten credentials": all three are
    taken as a refusal) and after how many failures it locks an account;
  - the lifetime of the api key, and how the cloud says it expired (a 302
    to the login page is assumed, as the library does; 401 / 403 too);
  - whether the house answers `ETag` / 304 (the library relies on it; without
    it, every reading is a full read, about 30-100 KB a minute);
  - whether one sign-in per container start creates a new "phone" in the
    account each time, or whether the stable device uuid avoids it (the
    library ships a script to delete old phones);
  - the command answers: the zone JSON (applied at once) or a short answer
    (a reading follows 10 s later); how long the UX360 takes to show a change
    (the library waits 7 s);
  - the mode values the cloud accepts per model (the zone's own option value
    is sent: "HEAT" on the XL series, "heat" on the UX360; the library sends
    upper case);
  - setpoints while following the schedule: the library leaves the run mode
    as it is (a temporary hold); confirm the thermostat keeps the value until
    the next schedule step;
  - Celsius accounts: limits and half degrees as in the recorded answers.
- [ ] **Milestone 3 — more**: presets (home / away / sleep as
      `thermostat/preset`), resume schedule / permanent hold, emergency heat
      (on/off, behind the option, never a switch), humidity setpoint
      commands, air cleaner mode, RoomIQ sensors, several houses.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public.

## Decisions

- **Version**: 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (the one-time exception to "versions
  belong to the Release workflow", the template's 1.0.0 and image name had to
  be replaced); the first Release (patch) gives 0.1.1.
- **License**: Apache-2.0, the standard text (no person named, copied from
  gladys-tedee), shipped in the image with `THIRD_PARTY_NOTICES.md` (nexia
  and Home Assistant, both Apache-2.0; the fixtures are nexia's test files).
- **Reference reused: nexia** (bdraco/nexia, Apache-2.0, maintained, the
  library of the Home Assistant integration), ported to JavaScript (it is
  Python). Neighbour modules: gladys-rheem-econet (cloud thermostats, units,
  modes) and gladys-incomfort (the approved command pattern).
- **Brands**: the three of the library and of Home Assistant: `nexia`
  (mynexia.com, "Nexia (Trane)"), `trane` (tranehome.com, "Trane Home"),
  `asair` (asairhome.com, "American Standard Home (Asair)"). The brief named
  "Trane Nexia, American Standard Home and Asair": American Standard Home
  _is_ the Asair brand, and Trane Home is the third one; all three offered.
- **Password**: a `secret` field, kept in clear by Gladys in its database
  (never written "encrypted"), sent only to the cloud of the brand. The api
  key and mobile id stay in memory (a restart signs in once); `/data` holds
  only the device uuid (random, stable per installation, as the library's
  state file), the end of a 429 pause and the refusal state (a SHA-256 of
  brand + e-mail, never the password nor the address).
- **Session**: the api key is reused at every reading (no login per cycle).
  A refused session (redirect, 401, 403) gets one new login, at most one
  every 5 min; refused again right after a login: the spacing doubles (10,
  20 min… 6 h), back to 5 min after a good reading.
- **Refused credentials** (sign-in 401 / 403 / redirect / `success: false`):
  stop; two automatic tries, 6 h and 24 h later, then none until the user
  saves the configuration or presses "Test the connection" (both forget the
  refusal). Kept in `/data` so a restart loop cannot hammer the account (the
  library: "any more attempts may lock your account").
- **HTTP 429**: Retry-After, bounded 1 min – 6 h, for every path (reading,
  commands, test button, restarts: kept in `/data`, capped when read back).
  Not lifted by the test button (prudent: the cloud asked). Not tied to an
  account. Other failures: 60 s doubling to 30 min, never faster than the
  60 s reading. A session wait is at least 60 s too.
- **`connected`**: the status, Discovery, states and badges are published
  again (the caches `lastStatus`, `discoveredKey`, transports and the SDK's
  published states are cleared); the client, the refusal and the pause stay.
- **Unit**: the thermostat's `scale` (`f` / `c`); a thermostat without a
  known unit is left out (logged once). Features get that unit at creation;
  states are converted to the unit of the feature as CREATED (read from
  `gladys.devices`); a command value is in that unit too.
- **Never lose a feature**: Discovery republishes a created device with every
  feature it was created with, their category, type, unit, bounds and
  options as created; new features are appended.
- **Outdoor temperature** as `temperature-sensor/probe` (kept out of the room
  temperature by the core). **Humidify / dehumidify setpoints** as
  `unknown/unknown` without unit (0-100): targets, not measures; the core
  averages every `humidity-sensor` of a room into its humidity.
- **System status and schedule / hold** as `text/text` (the cloud's English
  text, no history). **Fan mode** as `text/select` with the thermostat's own
  option values (`auto`, `on`, `circulate`): FAN_MODE of the core has no "on"
  nor "circulate" (as gladys-rheem-econet).
- **Zone mode** `thermostat/mode` (THERMOSTAT_MODE: off, heating, cooling,
  auto), the options the zone lists; emergency heat is shown as heating and
  not offered. The command sends only the mode (one request, within the
  budget), the value as the zone lists it; the run mode (hold / schedule) is
  left as it is (Home Assistant also sets a hold: not done here, prudent and
  faster — to check on a real account).
- **Operating state**: idle when the zone mode is off or the zone does not
  call, else heating / cooling from the zone status then the system status
  (Home Assistant's hvac_action). THERMOSTAT_OPERATING_STATE has no "off".
- **Setpoints**: plausible bounds checked on the raw value in the unit of the
  feature (40-99 °F, 4.5-37 °C) BEFORE conversion or rounding (22 sent to a
  °F feature is refused, never taken as 22 °F); then converted, rounded (1 °F,
  0.5 °C), checked against the zone's limits (refused, never clamped); the
  other setpoint moves to keep the deadband (`setpoint_delta`, default 3 °F /
  1.5 °C when missing), as the library's `set_heat_cool_temp`, and must stay
  within its own limits, else refused. Nothing sent when both values are
  already there. A missing setpoint (`null`) counts as the limit, like the
  library.
- **Commands** (`allow_control`, off by default; `read_only: false` is fixed
  at creation, so the permission is checked at each command, on arrival and
  just before sending): serialized for the account; the house read again
  (304 = the last reading is current) within 2.7 s; thermostat offline (the
  cloud's `connected: false` / "NOT CONNECTED") or zone gone: refused;
  nothing sent past 3.5 s after arrival; Gladys answered at 4.3 s at most,
  the states published without delaying the answer; a reading 10 s later.
  A late 429 or refusal applies to every path.
- **Command addresses**: the `href` the thermostat gives (`self` first, then
  the named action, as the library), used only when it is on the cloud of the
  brand, under `/mobile/`, in https, POST or PUT; else the library's fallback
  path built from the raw (checked) id. The api key never leaves for another
  host.
- **Offline thermostat**: `unreachable` badge (degraded, with a message), no
  states published (stale), commands refused.
- **Limits**: 20 thermostats, 12 zones each; answers capped at 4 MB; 250
  states per minute with a rotating cut; 100 badges per call.
- **No switch, no writable binary** anywhere: "turn everything off" never
  touches a thermostat.
- **Logs**: codes and HTTP statuses only, never the body of an answer, the
  e-mail, the password or the api key.
- **Duplicates**: checked by the pipeline before the batch (forum thread
  10385, store, Gladys core, GitHub), not again in this session.
