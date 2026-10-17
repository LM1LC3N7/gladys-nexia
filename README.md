# gladys-nexia

[Gladys Assistant](https://gladysassistant.com) external integration for
**Trane Nexia**, **Trane Home** and **American Standard Home** (Asair)
thermostats, through the cloud of their app: each thermostat becomes a Gladys
device (indoor humidity, outdoor temperature, system status, fan mode,
humidify / dehumidify setpoints), each zone a device (temperature, heating
and cooling setpoints, mode, operating state, schedule or hold). Setpoints,
zone mode and fan mode can be commanded once the user allows it (off by
default); nothing is ever a switch.
**Unofficial integration, not affiliated with Trane Technologies: it uses the
unofficial API of the app. Never tested with a real account yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (NexiaApp)
                 ├─ src/nexia/client.js   sign-in, session headers, house, commands
                 ├─ src/nexia/http.js     the only network access (fetch, no redirect, size cap)
                 ├─ src/nexia/model.js    house JSON -> thermostats and zones (ported from nexia)
                 ├─ src/nexia/errors.js   error codes
                 ├─ src/store.js          /data: device uuid, 429 pause, refusal
                 ├─ src/budget.js         states per minute
                 └─ src/devices.js        thermostats and zones (pure), unit conversion
```

- **Cloud**: `POST /mobile/accounts/sign_in` (e-mail, password, a device uuid
  kept in `/data`) gives a mobile id and an api key, kept in memory and sent
  with every request; `POST /mobile/session` gives the first house;
  `GET /mobile/houses/<id>` every 120 s with `If-None-Match` (a 304 costs
  nothing). Brands: `www.mynexia.com`, `www.tranehome.com`,
  `asairhome.com`. External ids: `thermostat:<id>`, `zone:<zone id>` (the
  UX360 numbers its zones: `<thermostat id>_<n>`, as the library does).
- **Session**: a redirect / 401 / 403 on a reading gets one new login, at
  most one every 5 minutes; a session refused right after its login doubles
  that spacing (up to 6 h), as does an accepted sign-in whose answer cannot be
  used. Never a login at each reading.
- **Refused credentials**: the integration stops; two automatic tries 6 h
  then 24 h later (kept in `/data` with a hash of the brand and the e-mail),
  then nothing until the user saves the configuration or presses "Test the
  connection" (at most once a minute after a refusal; the library warns that
  repeated failures may lock the account). Any 4xx of the sign-in but 408 is a
  refusal.
- **Failures**: the cloud unreachable is retried 120 s to 30 min (never faster
  than the reading); HTTP 429 pauses every path (2 min to 6 h, capped when
  read back from `/data`). Errors are logged as codes and HTTP statuses,
  never with the text of an answer, the e-mail, the password or the api key.
- **Units**: a feature takes the unit of the thermostat (°F or °C) when it is
  created; every value is converted to the unit of the feature as created in
  Gladys. A device the user created is republished with every feature it was
  created with (never "structure changed").
- **Commands** (`allow_control`, off by default): heating setpoint
  (`thermostat/target-temperature`), cooling setpoint
  (`air-conditioning/target-temperature`: the HomeKit bridge of the core reads
  the cooling threshold there), zone mode (`thermostat/mode`, sent in upper
  case like the library), fan mode (`text/select`). A setpoint is checked raw,
  in the unit of the feature (40-99 °F, 4.5-37 °C), before any conversion or
  rounding; then converted exactly, rounded once to the step (1 °F, 0.5 °C)
  and checked against the thermostat limits and deadband (none given:
  refused), the other setpoint moving to keep it. The house is read again
  just before acting; nothing is sent past 3.5 s; once sent, the request has
  its full 20 s; Gladys is answered at most 4.3 s after the command (past
  that: "sent, not confirmed", a reading 10 s later), the states follow
  without delaying it. One command at a time, until the real end of the
  previous one. The address a thermostat gives for a setting is used on the
  host of the brand chosen (same path when it names another brand's host, as
  the library's `resolve_url`); a UX360 zone without its own address is
  refused, never sent to an `xxl_zones` path.- **Reconnection to Gladys**: the status, Discovery, states and badges are
  published again; the session, a refusal and a 429 pause stay.

## Development

```bash
npm install
npm test                                        # node --test, no network (loopback only)
npm run lint && npm run format:check
npm run audit                                   # production dependencies
npm run cover                                   # regenerate cover.png
npx github:GladysAssistant/integration-store .  # store admission checks
```

The tests run against the SDK's fake Gladys and a fake cloud
(`test/helpers/fakeCloud.js`) serving the house answers recorded by the nexia
library (`test/fixtures/`). No test touches the real cloud.

## Credits

- [nexia](https://github.com/bdraco/nexia) (Apache-2.0): the API of the app,
  ported to JavaScript (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
- The `nexia` integration of
  [Home Assistant](https://github.com/home-assistant/core) (Apache-2.0): the
  brands, the modes and the operating state.
- [gladys-incomfort](https://github.com/LM1LC3N7/gladys-incomfort) and
  [gladys-rheem-econet](https://github.com/LM1LC3N7/gladys-rheem-econet): the
  structure of the app, the retry policy and the command checks.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
