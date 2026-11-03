# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.3] - 2026-11-03

### Fixed

- Adding a thermostat failed with "HTTP 422 … t_device_feature.min cannot be
  null": the fan mode list (`text`/`select`) had no `min` and `max`, which
  Gladys requires, so Gladys refused the whole device. It now has 0 and 0,
  like the other text/select integrations, and a test checks every feature of
  every device the module can build against the Gladys model. Gladys saves a
  device in one transaction, so nothing of the refused thermostat was kept:
  update, then add it again from the Discovery tab.

### Changed

- Integration SDK 0.16 (`^0.16.0`). The devices set `should_poll: false` and
  no `poll_frequency`, so Gladys 5.3 does not poll them. The test script stops
  a stuck test after 60 s (`node --test --test-timeout=60000`).

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-17

### Added

- First version, never tested with a real account (unofficial API of the
  app): Trane Nexia, Trane Home and American Standard Home (Asair)
  thermostats through their cloud, e-mail and password, the brand chosen in
  the configuration.
- One device per thermostat: indoor humidity, outdoor temperature, system
  status, fan mode, humidify / dehumidify setpoints (read only).
- One device per zone: temperature, heating setpoint (thermostat) and cooling
  setpoint (air-conditioning, as the HomeKit bridge reads it), mode (off,
  heating, cooling, auto), operating state, schedule or hold.
- °F or °C as the account reports it, converted to the unit each Gladys
  feature was created with.
- Commands off by default (`allow_control`): setpoints (checked raw before
  rounding, then against the thermostat's limits and deadband), zone mode,
  fan mode; the thermostat read again before acting, one command at a time,
  nothing sent past 3.5 s, a sent command never cut before its 20 s; no
  switch.
- Reading every two minutes (If-None-Match); the session kept between
  readings; HTTP 429 pause (2 min to 6 h) kept in `/data`; a refused password
  stops, with two automatic tries (6 h, 24 h), then none until the user acts
  (a forced sign-in at most once a minute after a refusal).
- Button "Test the connection".

[Unreleased]: https://github.com/LM1LC3N7/gladys-nexia/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/LM1LC3N7/gladys-nexia/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/LM1LC3N7/gladys-nexia/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-nexia/releases/tag/v0.1.1
