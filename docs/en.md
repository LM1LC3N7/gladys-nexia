# Nexia, Trane Home and American Standard Home

Thermostats of Trane Technologies (Trane XL series, American Standard Gold /
Platinum, UX360...) in Gladys, through the cloud of their app: **Nexia**
(mynexia.com), **Trane Home** (tranehome.com) or **American Standard Home**
(asairhome.com, also called Asair).

> **Unofficial integration**, not affiliated with Trane Technologies. It uses
> the unofficial API of the mobile app (the one the
> [nexia](https://github.com/bdraco/nexia) library and Home Assistant use),
> which may change without notice. It has never been tested with a real account:
> only against the answers recorded by the nexia library. Please report what
> you see.

## Configuration

1. **Brand (app)**: the app you sign in to. The three are the same cloud
   under three addresses.
2. **E-mail address** and **password** of that account. The password is kept
   by Gladys in its database (not encrypted, never shown again) and sent only
   to the cloud of the brand chosen.
3. Save. The status says how many thermostats and zones were found; the
   devices are in the **Discovery** tab.

**Test the connection** signs in again and lists the thermostats and zones.

### A refused password

Several wrong passwords in a row may lock the account. When the cloud refuses
the e-mail or the password, Gladys stops; it tries again by itself only twice,
6 hours and then 24 hours later (kept across restarts), then waits for you:
fix the password and save, or press **Test the connection**.

## Devices

**One device per thermostat** (the system):

- indoor humidity (%);
- outdoor temperature, when the system has a sensor (kept out of the room
  temperature in Gladys);
- system status (text from the cloud: "Cooling", "System Idle"...);
- fan mode (auto, on, circulate: the options the thermostat offers);
- humidify / dehumidify setpoints (%), when a humidifier or a dehumidifier is
  installed (read only).

**One device per zone** (a system without zoning has one zone, with the name
of the thermostat):

- temperature;
- heating setpoint and cooling setpoint;
- mode: off, heating, cooling, auto (emergency heat is shown as heating);
- operating state: idle, heating, cooling;
- schedule or hold (text from the cloud).

Temperatures are in the unit of the account (°F or °C) when the device is
created; Gladys converts them if the account changes unit later.

The values are read **every minute** (the cloud answers "nothing new" most
of the time, which costs almost nothing). A thermostat the cloud reports
offline is shown unreachable, and its values are not published.

## Commands (off by default)

By default Gladys only reads. Tick **Allow commands** to let the dashboard,
the scenes, the voice assistants and the Thermostat service of Gladys change:

- the **heating and cooling setpoints** of a zone. A value is checked before
  anything else (40 to 99 °F, or 4.5 to 37 °C, in the unit of the Gladys
  feature): a value out of it is refused, never adjusted. It is then rounded
  like the app (1 °F, 0.5 °C) and checked against the limits of the
  thermostat; the other setpoint moves to keep the gap the thermostat asks
  for (the "deadband"), as in the app;
- the **mode** of a zone (off, heating, cooling, auto);
- the **fan mode**.

Before each command Gladys reads the thermostat again: if it is offline, if
the zone is gone or if the value is already there, nothing is sent. One
command at a time. There is never a switch to turn the heating off: "turn
everything off" in Gladys does not touch the thermostats.

A setpoint changed this way may hold until the next step of the schedule of
the thermostat, as in the app.

## Limits

- HTTP 429 (too many requests): every request waits (1 minute to 6 hours),
  across restarts too.
- Cloud unreachable: retried after 1 minute, then less and less often (up to
  30 minutes).
- The first house of the account only.
- Not yet: presets (home, away, sleep), schedule resume, emergency heat,
  humidity setpoint commands, air cleaner, RoomIQ sensors.

## Privacy

The e-mail address and the password go only to the cloud of the brand chosen.
The session key stays in memory. `/data` of the container holds only a random
identifier of this installation (the app sends one), the end of a 429 pause
and the state of a refusal (a hash of the brand and the e-mail, never the
password).
