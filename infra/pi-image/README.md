# discodb2 — Raspberry Pi image (first-boot provisioning)

Turns a **stock Raspberry Pi OS Lite (32-bit, ARMv6)** image into the in-car
discodb2 box: `can0` listen-only, a WPA2 WiFi access point, and the backend
running as a service on boot.

## Why stock-image + provisioning (not a baked image)

DESIGN §8 mandates a **single 32-bit ARMv6 RPi OS Lite** image covering
**Pi 1B+ → 3B+** (Pi Zero is dropped — no USB ports for the adapter). We do
**not** ship a pre-baked `.img`. Instead we flash the official image and run
[`scripts/install.sh`](scripts/install.sh) once. Why:

- **Arch-agnostic & reproducible.** The same provisioning runs on any Pi model
  the ARMv6 image supports; no per-arch bake.
- **CI-friendly.** A full QEMU bake of an ARMv6 image is slow and flaky in CI.
  CI instead lints + smoke-tests the provisioning bundle and publishes it as an
  artifact (see `.github/workflows/` and the honest limits called out there).
- **Lean by construction.** ARMv6 has no prebuilt numpy/pandas/cantools wheels;
  building them on-Pi is brutal. `install.sh` installs only the lean backend
  deps (DESIGN §4.3) and **refuses** a backend requirements file that pulls in
  numpy/pandas/cantools.

> No RTC: the Pi has no real-time clock (DESIGN §4.2). None of these units or
> scripts depend on wall-clock time; the backend uses monotonic/HW µs and the
> connecting client assigns absolute session time.

## What gets installed

| Piece | File | Does |
|---|---|---|
| CAN bring-up | `scripts/can-up.sh` + `systemd/discodb2-can.service` | `modprobe gs_usb`, wait for `can0`, bring it up **listen-only** at `CAN_BITRATE` |
| WiFi AP | `scripts/ap-setup.sh` + `systemd/discodb2-ap.service` | generate hostapd (WPA2) + dnsmasq (DHCP) + static IP from the env file |
| Backend | `systemd/discodb2-backend.service` | run the backend on boot (`sim`/`socketcan`/`replay`) as user `discodb2` |
| mDNS discovery | `scripts/avahi-setup.sh` + `avahi/discodb2.service` | tell the **OS** `avahi-daemon` to publish the box as `discodb.local` and advertise the backend (`_http._tcp` on `BACKEND_PORT`) on the LAN |
| Config | `config/discodb2.env` | **single source of truth** → `/etc/discodb2/discodb2.env` |

The CAN / AP / backend services are independent: the backend still runs on
`sim`/`replay` even if the adapter is unplugged (DESIGN §4.4), and the AP comes
up regardless of the bus. mDNS is pure convenience layered on top — see
[LAN service discovery](#lan-service-discovery-mdns--no-backend-cost) below;
if it is ever unavailable the **fixed AP IP `192.168.4.1` always works**.

## Flash + provision (the documented path)

1. **Flash the stock image.** Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
   and choose **Raspberry Pi OS Lite (32-bit)**. In Imager's advanced options
   (gear icon) you *may* set a hostname and enable SSH — but **do not** rely on
   its WiFi setting; we run our own AP. (Imager configures *client* WiFi, which
   conflicts with AP mode.)

2. **Copy the repo onto the card** (or `git clone` after first boot). Easiest:
   after flashing, the boot partition is writable — but the repo lives on the
   root partition, so the simplest path is to boot once with a temporary wired
   connection / keyboard and `git clone` the repo to `/opt/discodb2`, or `scp`
   it there.

3. **Run the installer as root:**
   ```sh
   sudo sh /opt/discodb2/infra/pi-image/scripts/install.sh
   ```
   It deploys the repo to `/opt/discodb2`, installs apt packages, creates the
   lean Python venv, writes `/etc/discodb2/discodb2.env`, and enables the three
   systemd units.

4. **Edit the config** — at minimum set a real `AP_PASSPHRASE` (open WiFi is
   rejected) and confirm `CAN_BITRATE`:
   ```sh
   sudo nano /etc/discodb2/discodb2.env
   sudo systemctl restart discodb2-ap.service   # re-apply AP config without reboot
   ```

5. **Reboot.** `sudo reboot`. Then from a phone/laptop:
   - Join WiFi **`discodb2`** (or your `AP_SSID`) with your passphrase.
   - **Friendly (mDNS):** browse to **`http://discodb.local:8765`**. The frontend
     auto-connects its WebSocket to `ws://discodb.local:8765/ws` (same host that
     served the page — no IP typing). See
     [LAN service discovery](#lan-service-discovery-mdns--no-backend-cost).
   - **Fallback (always works):** browse to `http://192.168.4.1:8765` and, if
     needed, connect `ws://192.168.4.1:8765/ws`. Use this if a client's mDNS is
     flaky (some Android builds, locked-down corp laptops).

### Optional: zero-touch first run

To provision without a keyboard, append a one-shot call to `install.sh` from
the boot-partition `firstrun.sh` / `cmdline.txt` hook that Pi OS supports, or
drop a `systemd` oneshot that runs the installer and then disables itself. This
repo ships the building blocks; wiring the firstrun hook is a per-deployment
choice (it depends on how you get the repo onto the card).

## LAN service discovery (mDNS — no backend cost)

So nobody has to type `192.168.4.1`, the box advertises itself on the LAN via
the **operating system's** mDNS responder, **Avahi**. Provisioning installs
`avahi-daemon`, then [`scripts/avahi-setup.sh`](scripts/avahi-setup.sh):

1. **Pins the mDNS host-name to `discodb`** in `/etc/avahi/avahi-daemon.conf`,
   so Avahi publishes an A-record for **`discodb.local`** on every interface.
   (It sets *Avahi's* host-name only — your system hostname, `/etc/hosts`, and
   shell prompt are untouched, so this is deterministic no matter what you set
   in Raspberry Pi Imager.) Override with `MDNS_HOSTNAME` in the env file.
2. **Materialises [`avahi/discodb2.service`](avahi/discodb2.service)** to
   `/etc/avahi/services/discodb2.service`, advertising the backend as a DNS-SD
   service of type `_http._tcp` on `BACKEND_PORT` (8765, DESIGN §3.1).
3. **Enables `avahi-daemon.service`** so it survives reboots.

Result, after joining the AP:

- **`http://discodb.local:8765`** serves the frontend, and the page's WebSocket
  auto-targets **`ws://discodb.local:8765/ws`** — no IP typing anywhere.

### Why this costs the backend nothing (the leanness invariant)

This is the **system** responder, not backend code. `avahi-daemon` is a tiny,
event-driven daemon: it answers the rare multicast mDNS query and otherwise
sits idle — **no polling, no per-frame work, zero CPU on the backend's hot
path**. The backend process is **not modified and not involved**. That matters
on a Pi 1B+ (DESIGN §4.3 leanness): discovery is delegated to the OS so the
thin CAN backend stays thin. There is no new long-running discodb2 process —
we reuse Avahi's own `avahi-daemon.service`.

### The browser caveat (why the `.service` advert is for tooling, not the app)

A web page **cannot enumerate mDNS/DNS-SD** — browsers expose no JavaScript API
to browse `_http._tcp` and "find" the Pi. So the `_http._tcp` record above is
for **OS-level discovery tools** (`avahi-browse -a`, `dns-sd -B _http._tcp`, the
macOS "Bonjour" stack), not for the app to auto-locate the backend.

The app doesn't need that. Two facts combine into a no-IP-typing UX:

- The **OS resolves `.local` names** (Avahi on Linux, Bonjour on macOS, the mDNS
  resolver on Windows 10+/iOS). So a human types `http://discodb.local:8765`
  once and the OS resolves it — no app involvement.
- Both frontends **default their WebSocket to the same host that served the
  page** (`ws://<location.hostname>:8765/ws` — see
  `frontend/cockpit/src/state/store.ts` and `frontend/copilot/src/lib/store.svelte.ts`).
  Served from `discodb.local`, the WS auto-targets `discodb.local`.

**Friendly host A-record + same-host WebSocket default = no IP typing**, with
the fixed `192.168.4.1` always available as the fallback.

> **macOS PC backend:** if you run the backend on a Mac instead of the Pi,
> **Bonjour already covers it** — macOS advertises its own `*.local` host-name
> out of the box, so `http://<mac-name>.local:8765` works with no extra setup
> (this Avahi step is the Pi-side equivalent of that built-in Bonjour).

### Verify mDNS on the Pi

```sh
systemctl status avahi-daemon                 # responder running
avahi-resolve -n discodb.local                # -> discodb.local  192.168.4.1
avahi-browse -rt _http._tcp                    # the discodb2 advert appears
```

From a client: `ping discodb.local` (macOS/Linux/Win10+), or just open
`http://discodb.local:8765`. If your client can't resolve `.local` (some older
Android), fall back to `http://192.168.4.1:8765`.

> Heads-up: the AP's `dnsmasq` also hands out a separate **unicast**-DNS name,
> `discodb2.local` → `192.168.4.1`, to DHCP clients (pre-existing AP behaviour).
> The friendly URL above is the **mDNS** `discodb.local` published by Avahi;
> both point at the same Pi. When in doubt, the **IP** is the source of truth.

## TP-Link USB dongle — AP / master-mode caveat (READ THIS)

DESIGN §8 dev box: **Pi 1 B+ (4 USB) + a TP-Link USB WiFi dongle**. The Pi 1B+
has **no onboard WiFi**, so the AP must run on the dongle. **Not every TP-Link
dongle can be an access point.** AP (a.k.a. "master" / "AP" mode) requires:

- A chipset + driver whose **nl80211** interface supports **AP mode**, and
- `hostapd` support for that driver.

Known-bad pattern: many cheap TP-Link dongles use **Realtek** chipsets
(`rtl8188eu`, `rtl8192cu`, `rtl8821au`, `rtl8812au`, …). Their **out-of-tree**
drivers historically **do not** advertise AP mode to `nl80211`/`hostapd`, or do
so only with a vendor-patched `hostapd` and a non-standard `driver=rtl871xdrv`
line. The in-kernel `rtl8xxxu` driver often lacks AP support entirely.

**Verify BEFORE you rely on it:**
```sh
# 1) Identify the chipset:
lsusb                      # note the VID:PID, e.g. 2357:0109 (TP-Link)
# 2) Ask the driver what modes the interface supports:
iw list | sed -n '/Supported interface modes/,/^$/p'
#    -> the list MUST contain "AP". If it only lists "managed"/"monitor",
#       this dongle CANNOT host the discodb2 AP with stock hostapd.
```
If `AP` is absent: use a **different dongle with a known AP-capable chipset**
(e.g. Atheros `ath9k_htc` — AR9271, or RTL8188EUS *only* with the patched
`8188eu`/`rtl8188eus` DKMS driver and `driver=rtl871xdrv` in hostapd.conf), or
move to a **Pi 3B+** whose **onboard** radio (`brcmfmac`, `wlan0`) does AP mode
out of the box. Set `AP_IFACE` in `discodb2.env` to whichever interface the
working radio enumerates as (`wlan0` onboard, often `wlan1` for a USB dongle).

> Bottom line: the Pi 3B+ onboard radio is the path of least resistance for the
> AP. The TP-Link dongle is fine for a Pi 1B+ **only after** `iw list` shows
> `AP` in its supported modes.

## Troubleshooting

```sh
systemctl status discodb2-can discodb2-ap discodb2-backend
journalctl -u discodb2-backend -b          # backend logs since this boot
ip -details link show can0                 # confirm "can ... LISTEN-ONLY ... state UP"
iw dev                                      # confirm the AP iface is in type AP
sudo hostapd -dd /etc/hostapd/hostapd.conf  # foreground hostapd debug if AP won't start
candump can0                                # raw frames (sanity-check the bus)
systemctl status avahi-daemon               # mDNS responder (discodb.local)
avahi-browse -rt _http._tcp                 # confirm the backend advert is published
```

- **`can0` missing:** `dmesg | grep -i gs_usb`; check `lsusb` shows `1d50:606f`.
  The adapter must be candleLight/gs_usb firmware (not slcan) for the in-kernel
  `gs_usb` driver to bind.
- **AP won't beacon:** almost always the dongle caveat above, or `AP_COUNTRY`
  not set (the radio refuses to transmit without a regulatory domain).
- **Phone connects but no page:** check `discodb2-backend` is running and
  `BACKEND_PORT` matches what you browse to.
- **`discodb.local` won't resolve:** the **fixed IP `192.168.4.1` always works**
  — use it. mDNS itself: `systemctl status avahi-daemon`, then
  `avahi-resolve -n discodb.local`. Some Android builds don't resolve `.local`
  (use the IP); on Windows pre-10 install Bonjour or use the IP. If the advert
  is missing, re-run `sudo sh .../scripts/avahi-setup.sh`.
