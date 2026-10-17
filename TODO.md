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
      °F / °C converted to the unit of each created feature; 429 pause and
      refusal kept in `/data`; commands off by default (setpoints, zone
      mode, fan mode), fresh read before acting, 3.5 s budget, answer at
      4.3 s at most; "Test the connection"; docs en/fr; cover. Tested with
      unit tests against the SDK's fake Gladys and a fake cloud serving the
      nexia library's recorded answers. **Never tested with a real
      account.** No Docker on this PC: no e2e test in a container.
- [x] **Review fixes** (2026-10-17): a slow command keeps its full request
      timeout once sent (never cut at 3.5 s), "sent, not confirmed" past the
      answer, the next command waits for its real end, a network error is
      "not sent"; the house looked up again when missing (never
      `/houses/null`); an accepted sign-in that cannot be used, or a house
      lookup refused right after it, doubles the sign-in spacing; the cooling
      setpoint as `air-conditioning/target-temperature` (HomeKit); command
      addresses on another brand's host rewritten to the brand's host, no
      `xxl_zones` fallback for a UX360 zone; any 4xx of the sign-in but 408 is
      a refusal, forced sign-ins at most once a minute after a refusal, the
      test button re-reads with a working session; exact conversion then one
      rounding, `step`, mode `max`, no assumed deadband, modes in upper case,
      the number of automatic tries left, distinct waiting / network
      messages; reading every 120 s; docs (HomeKit, the Off mode, `/data`).
- [ ] **Milestone 2 — real account** (a tester): record real answers as
      fixtures (e-mail, ids and keys removed), fix what differs. To check
      first:
  - what the cloud answers to a wrong password today (200 + `success:
false`, 401, 422, or a redirect to "forgotten credentials": all are
    taken as a refusal) and after how many failures it locks an account;
  - the lifetime of the api key, and how the cloud says it expired (a 302
    to the login page is assumed, as the library does; 401 / 403 too);
  - whether the house answers `ETag` / 304 (the library relies on it; without
    it, every reading is a full read, about 30-100 KB every two minutes);
  - whether one sign-in per container start creates a new "phone" in the
    account each time, or whether the stable device uuid avoids it (the
    library ships a script to delete old phones);
  - the command answers: the zone JSON (applied at once) or a short answer
    (a reading follows 10 s later); how long the UX360 takes to show a change
    (the library waits 7 s); how long a slow command really takes;
  - the mode values: upper case is sent to every model, as the library does
    in production; check the UX360 (its options are lower case);
  - setpoints while following the schedule: the library leaves the run mode
    as it is (a temporary hold); confirm the thermostat keeps the value until
    the next schedule step;
  - Celsius accounts: limits and half degrees as in the recorded answers;
  - HomeKit: one thermostat service with a heating
    (`thermostat/target-temperature`) and a cooling
    (`air-conditioning/target-temperature`) threshold, as the core's
    buildThermostatService.js reads them.
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
  brand + e-mail, never the password nor the address). `/data` not writable:
  kept in memory, a new uuid at each restart (one more "phone" in the
  account each time; said in the docs).
- **Reading every 120 s** (Home Assistant's rate; the brief said 60 s, the
  review asked for 120 s: fewer requests to an unofficial API). Every wait
  after an error is at least that long: retries 120 s doubling to 30 min,
  429 at least 120 s, a sign-in wait at least 120 s.
- **Session**: the api key is reused at every reading (no login per cycle).
  A refused session (redirect, 401, 403) gets one new login, at most one
  every 5 min; refused again right after a login, a house lookup refused
  right after it, or an accepted sign-in whose answer cannot be used: the
  spacing doubles (10, 20 min… 6 h), back to 5 min after a good reading. A
  sign-in with no answer (network, timeout, 5xx, 408) does not use up the
  spacing (the app's retry delay paces it) and shows as "cloud does not
  answer"; waiting for the spacing has its own message. A session without a
  house (the lookup failed) looks the house up again, never `/houses/null`.
- **Refused credentials** (sign-in: any 4xx but 408, a redirect, or
  `success: false`): stop; two automatic tries, 6 h and 24 h later, then none
  until the user saves the configuration or presses "Test the connection"
  (both forget the refusal, and restart the two automatic tries). A forced
  sign-in waits until a minute has passed since the last refusal. Kept in
  `/data` so a restart loop cannot hammer the account (the library: "any
  more attempts may lock your account"). The status says how many automatic
  tries are left.
- **Test button**: with a working session and the same configuration, it
  reads the house again, without a new sign-in; else it signs in (forced).
- **HTTP 429**: Retry-After, bounded 2 min – 6 h, for every path (reading,
  commands, test button, restarts: kept in `/data`, capped when read back).
  Not lifted by the test button (prudent: the cloud asked). Not tied to an
  account.
- **`connected`**: the status, Discovery, states and badges are published
  again (the caches `lastStatus`, `discoveredKey`, transports and the SDK's
  published states are cleared); the client, the refusal and the pause stay.
- **Unit**: the thermostat's `scale` (`f` / `c`); a thermostat without a
  known unit is left out (logged once). Features get that unit at creation;
  states are converted to the unit of the feature as CREATED (read from
  `gladys.devices`); a command value is in that unit too.
- **Never lose a feature**: Discovery republishes a created device with every
  feature it was created with, their category, type, unit, bounds, step and
  options as created; new features are appended.
- **Outdoor temperature** as `temperature-sensor/probe` (kept out of the room
  temperature by the core). **Humidify / dehumidify setpoints** as
  `unknown/unknown` without unit (0-100): targets, not measures; the core
  averages every `humidity-sensor` of a room into its humidity.
- **System status and schedule / hold** as `text/text` (the cloud's English
  text, no history). **Fan mode** as `text/select` with the thermostat's own
  option values (`auto`, `on`, `circulate`): FAN_MODE of the core has no "on"
  nor "circulate" (as gladys-rheem-econet).
- **Heating setpoint `thermostat/target-temperature`, cooling setpoint
  `air-conditioning/target-temperature`** (both accept °C / °F): the HomeKit
  bridge of the core (buildThermostatService.js) reads the cooling threshold
  only from the latter, and two thermostat targets on one device are
  ambiguous to it. `step` 1 °F / 0.5 °C (the library's rounding).
- **Zone mode** `thermostat/mode` (THERMOSTAT_MODE: off, heating, cooling,
  auto), the options the zone lists, `max` the highest one offered; emergency
  heat is shown as heating and not offered. The command sends only the mode
  (one request, within the budget), in upper case ("HEAT", "OFF"...), as the
  library sends it to every model in production (the UX360 lists lower-case
  options); the run mode (hold / schedule) is left as it is (Home Assistant
  also sets a hold: not done here, prudent and faster — to check on a real
  account). Off stops heating and cooling with no frost protection, and may
  come from HomeKit ("turn off") or the Thermostat service: said in the docs
  and the manifest. HomeKit is the only voice assistant that reaches
  thermostats in Gladys.
- **Operating state**: idle when the zone mode is off or the zone does not
  call, else heating / cooling from the zone status then the system status
  (Home Assistant's hvac_action). THERMOSTAT_OPERATING_STATE has no "off".
- **Setpoints**: plausible bounds checked on the raw value in the unit of the
  feature (40-99 °F, 4.5-37 °C) BEFORE conversion or rounding (22 sent to a
  °F feature is refused, never taken as 22 °F); then converted exactly and
  rounded once to the step (1 °F, 0.5 °C), checked against the zone's limits
  (refused, never clamped); the other setpoint moves to keep the deadband
  (`setpoint_delta`; none given: the command is refused, no deadband is
  assumed), as the library's `set_heat_cool_temp`, and must stay within its
  own limits, else refused. Nothing sent when both values are already there.
  A missing setpoint (`null`) counts as the limit, like the library.
- **Commands** (`allow_control`, off by default; `read_only: false` is fixed
  at creation, so the permission is checked at each command, on arrival and
  just before sending): serialized for the account, the next one waiting for
  the REAL end of the previous (not only for its answer to Gladys); the house
  read again (304 = the last reading is current) within 2.7 s; thermostat
  offline (the cloud's `connected: false` / "NOT CONNECTED") or zone gone:
  refused; nothing sent past 3.5 s after arrival. Once sent, the request has
  its full timeout (20 s): a slow cloud may still apply it, so it is never
  cut and called a failure. Gladys answered at 4.3 s at most ("sent"); a
  later failure or timeout is "sent, not confirmed" in the logs, and the
  house is read again 10 s later. A network error (no connection) is
  "nothing was sent". States published without delaying the answer. A late
  429 or refusal applies to every path.
- **Command addresses**: the `href` the thermostat gives (`self` first, then
  the named action, as the library). On one of the three brand hosts, in
  https, under `/mobile/`, POST or PUT: the path is kept and the host
  becomes the one of the brand chosen (the library's `resolve_url`); else
  the library's fallback path built from the raw (checked) id — except for a
  UX360 zone (numbered per thermostat, an integer under 256) or a non-XL
  thermostat's fan, where the `xxl_*` fallback would hit another zone or
  nothing: refused, nothing sent. The api key never leaves for another host.
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
