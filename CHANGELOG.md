# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
