# Third-party notices

This integration ports to JavaScript the logic of the projects below for
talking to the cloud of Trane Nexia, Trane Home and American Standard Home
(Asair) thermostats. Nothing of them is installed at runtime: they are
Python, this integration is JavaScript.

## nexia

<https://github.com/bdraco/nexia> (read at commit `3a2b7d8`, 2026-07-01,
version 2.13.0), by Ryan Nazaretian and J. Nick Koston, licensed under the
Apache License, Version 2.0. The full text of the license is the `LICENSE`
file of this repository (the same Apache License 2.0); the project has no
NOTICE file.

Ported in `src/nexia/client.js`, `src/nexia/model.js` and `src/app.js`: the
addresses of the three brands and the `/mobile` paths (`accounts/sign_in`,
`session`, `houses/<id>`, `xxl_zones/<id>/setpoints`, `zone_mode`,
`xxl_thermostats/<id>/fan_mode`), the sign-in payload and the
`X-AppVersion` / `X-AssociatedBrand` / `X-MobileId` / `X-ApiKey` headers, the
first house of the session, the `If-None-Match` reading, the session taken
as expired on a redirect; where the values are in the house JSON (thermostat
and zone features and settings, the fallbacks between the XL series and the
UX360), the groups, the zone id (`<thermostat>_<n>` for the UX360), the
"calling" state of a zone, the hold / schedule labels, the actions a setting
names (`self` first), the rounding of the setpoints (1 °F, 0.5 °C), the
deadband kept by moving the other setpoint, and the limits checked before
sending. The test data in `test/fixtures/` are files of its tests, kept as
published.

## Home Assistant, `nexia` integration

<https://github.com/home-assistant/core/tree/dev/homeassistant/components/nexia>
(read at commit `5cfe9aa`, 2026-10-16), licensed under the Apache License,
Version 2.0. The full text of the license is the `LICENSE` file of this
repository (the same Apache License 2.0).

Followed, without copying code: the three brands offered to the user, the
refused credentials taken from HTTP 401 / 403, the mapping of the zone modes
(off, heating, cooling, auto), the operating state of a zone (idle when the
zone does not call, else heating or cooling from the system status), the
sensors offered (humidity, outdoor temperature, humidify / dehumidify
setpoints, zone status) and the unique ids built on the thermostat and zone
ids.

```
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## LM1LC3N7/gladys-incomfort and LM1LC3N7/gladys-rheem-econet

The structure of the app, the handler wiring, the retry and pause policy and
the command checks follow integrations of the same author, under the Apache
License 2.0 of this repository.
