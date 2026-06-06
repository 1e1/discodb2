# discodb2 — Raspberry Pi DEPLOYMENT GUIDE + VALIDATION CHECKLIST

Turns a **stock Raspberry Pi OS Lite (32-bit, ARMv6)** image into the in-car
discodb2 box: `can0` listen-only, a WPA2 WiFi access point, mDNS discovery, and
the thin backend running as a service on boot.

> **Status — first hardware bring-up.** The provisioning bundle (scripts +
> systemd units + env) is written and lint/smoke-tested, but **most of it has
> not yet been exercised on a real Pi**. Steps that need physical hardware to
> confirm are tagged **⚠️ unverified — validate on first hardware run**. The
> [Validation Checklist](#validation-checklist-run-on-real-hardware) at the end
> is the script to run on the dev box (Pi 1 B+) to confirm each piece.
>
> **The infra bugs found while writing this guide are now FIXED** (backend
> launch module, the bogus `--listen-only` flag, the missing web host, and the
> duplicate `.local` name). See [Fixed infra bugs](#fixed-infra-bugs) for the
> before→after. What remains tagged ⚠️ is genuinely hardware-dependent
> (dongle AP capability, CAN bring-up, live AP beaconing).

---

## 1. Image choice + flashing

DESIGN §8 mandates a **single 32-bit ARMv6 Raspberry Pi OS Lite** image covering
**Pi 1B+ → 3B+**. ARMv6 is the lowest common denominator, so one image runs
everywhere we support.

| Pi model | Supported | Notes |
|---|---|---|
| Pi 1 B+ | ✅ (dev box) | 4 USB ports; **no onboard WiFi** → AP must run on a USB dongle |
| Pi 2 B | ✅ | needs ARMv6 image (the single image) |
| Pi 3 B / 3 B+ | ✅ | onboard WiFi (`brcmfmac`) does AP mode out of the box — path of least resistance |
| Pi Zero / Zero W | ❌ **dropped** | no USB-A ports for the CAN adapter |

**Why stock image + first-boot provisioning (not a baked `.img`):**

- **Arch-agnostic & reproducible** — the same provisioning runs on every model
  the ARMv6 image supports; no per-arch bake.
- **CI-friendly** — a full QEMU bake of an ARMv6 image is slow and flaky; CI
  lints + smoke-tests the provisioning bundle and publishes it as an artifact
  instead.
- **Lean by construction** — ARMv6 has no prebuilt numpy/pandas/cantools wheels;
  building them on-Pi is brutal. `install.sh` installs only the lean backend
  deps (DESIGN §4.3) and **refuses** a backend requirements file that pulls in
  numpy/pandas/cantools.

**Flash:** use [Raspberry Pi Imager](https://www.raspberrypi.com/software/) and
choose **Raspberry Pi OS Lite (32-bit)**. In Imager's advanced options (gear
icon) you *may* set a hostname and enable SSH — but **do not** set its WiFi:
Imager configures *client* WiFi, which conflicts with our AP mode.

> **No RTC.** The Pi has no real-time clock (DESIGN §4.2). None of these units
> or scripts depend on wall-clock time; the backend uses monotonic/HW µs and the
> connecting client assigns absolute session time. The CAN bring-up uses a
> bounded retry loop, not timestamps.

---

## 2. First-boot provisioning (`install.sh`)

Get the repo onto the Pi (boot once with a keyboard/wired link and `git clone`
to `/opt/discodb2`, or `scp` it there), then run the installer **as root**:

```sh
sudo sh /opt/discodb2/infra/pi-image/scripts/install.sh
```

[`scripts/install.sh`](scripts/install.sh) does, in order:

1. **Deploys the repo to `/opt/discodb2`** (tar copy, excluding `.git`,
   `node_modules`, `.venv`, `__pycache__`). Skips if already there.
2. **Installs apt packages** (all have ARMv6 debs):
   `hostapd dnsmasq can-utils iproute2 rfkill iw avahi-daemon avahi-utils
   python3 python3-venv python3-pip`. Unmasks `hostapd`.
3. **Installs the config** — copies
   [`config/discodb2.env`](config/discodb2.env) to `/etc/discodb2/discodb2.env`
   (mode `600`) if not already present, then sources it. **Does not overwrite an
   existing env file.**
4. **Creates the `discodb2` system user** + `/opt/discodb2/recordings` (owned by
   that user).
5. **Creates the lean Python venv** at `/opt/discodb2/.venv`. If
   `backend/requirements.txt` (or `requirements-pi.txt`) exists it installs that
   — **but aborts** if it matches `numpy|pandas|cantools`. Otherwise it installs
   a lean baseline (`python-can==4.4.2`, `websockets>=12.0`).
6. **Installs + enables the systemd units** `discodb2-can`, `discodb2-ap`,
   `discodb2-backend`, `discodb2-web` (the static cockpit host), plus `hostapd`
   and `dnsmasq`. Warns if the pre-built cockpit `dist/` is missing at
   `$WEB_ROOT` (it is built off-Pi and shipped — see §6).
7. **Runs [`avahi-setup.sh`](scripts/avahi-setup.sh)** for mDNS and enables
   `avahi-daemon` (best-effort — non-fatal if it fails; the fixed IP still
   works).

The installer is idempotent enough to re-run.

### The systemd units

| Unit | Type | Does |
|---|---|---|
| [`discodb2-can.service`](systemd/discodb2-can.service) | oneshot, `RemainAfterExit` | runs `can-up.sh` after `systemd-udev-settle`; `ExecStop` drops the link. `SuccessExitStatus=0 1` so a missing adapter does not fail the boot |
| [`discodb2-ap.service`](systemd/discodb2-ap.service) | oneshot, `RemainAfterExit` | runs `ap-setup.sh`, then `ExecStartPost` restarts `hostapd` + `dnsmasq` |
| [`discodb2-backend.service`](systemd/discodb2-backend.service) | simple, `Restart=on-failure` | `WorkingDirectory=/opt/discodb2/backend`, runs `${BACKEND_PYTHON} -m discodb2_backend --source … --bitrate … --port … --host 0.0.0.0` as user `discodb2` with `CAP_NET_RAW`, `ProtectSystem=strict`, `recordings/` read-write |
| [`discodb2-web.service`](systemd/discodb2-web.service) | simple, `Restart=on-failure` | serves the pre-built cockpit `dist/` (`$WEB_ROOT`) via stdlib `python3 -m http.server $WEB_PORT` (default port 80) — **no extra packages**, ARMv6-friendly; runs as `discodb2` with `CAP_NET_BIND_SERVICE` for the privileged port |

`discodb2-backend` `Wants` (not `Requires`) the CAN + AP units, so the backend
**still runs on `sim`/`replay` even if `can0` is unplugged** (DESIGN §4.4).
`discodb2-web` is independent of the backend: the page loads even if the
backend is down, and connects to it over WS once it is up.

### `config/discodb2.env` — single source of truth

Copied to `/etc/discodb2/discodb2.env`, sourced by every script and unit. Plain
`KEY=value`.

| Key | Default | Meaning |
|---|---|---|
| `CAN_BITRATE` | `500000` | bus bitrate (VW PQ powertrain ~500k; comfort buses often 100k) |
| `CAN_IFACE` | `can0` | CAN interface name |
| `CAN_LISTEN_ONLY` | `1` | link-layer listen-only (defence-in-depth; backend enforces it too) |
| `AP_SSID` | `discodb2` | WiFi network name |
| `AP_PASSPHRASE` | `changeme-discodb2` | **CHANGE THIS** — WPA2, 8..63 chars; open WiFi is rejected |
| `AP_CHANNEL` | `6` | 2.4 GHz channel (1/6/11 non-overlapping) |
| `AP_COUNTRY` | `FR` | regulatory domain — **radio will not beacon without it** |
| `AP_ADDR` | `192.168.4.1` | fixed AP IP (always-works fallback) |
| `AP_NETMASK` / `AP_DHCP_START` / `AP_DHCP_END` | `255.255.255.0` / `.50` / `.150` | DHCP pool |
| `AP_IFACE` | `wlan0` | AP interface — **onboard = `wlan0`, a USB dongle often enumerates as `wlan1`** |
| `DISCODB2_HOME` | `/opt/discodb2` | deploy location |
| `BACKEND_PORT` | `8765` | backend WebSocket/HTTP port |
| `BACKEND_SOURCE` | `socketcan` | source the backend autostarts (`sim`/`socketcan`/`replay`) |
| `BACKEND_PYTHON` | `/opt/discodb2/.venv/bin/python` | venv interpreter |
| `WEB_PORT` | `80` | port the static cockpit host (`discodb2-web`) listens on |
| `WEB_ROOT` | `/opt/discodb2/frontend/cockpit/dist` | pre-built cockpit `dist/` the web host serves |
| `MDNS_HOSTNAME` | `discodb` | Avahi **and** dnsmasq `.local` name — one host name (does **not** change the system hostname) |

After editing: `sudo systemctl restart discodb2-ap.service` (re-applies AP
config without a reboot), or reboot.

> **First-boot safety tip.** `BACKEND_SOURCE` ships as `socketcan`. For the very
> first boot — before the bus is wired and verified — set it to `sim` so the
> backend comes up with zero hardware and you can validate the AP + UI path in
> isolation. Switch to `socketcan` once `can0` is confirmed (§3).

---

## 3. CAN bring-up (`can-up.sh`)

[`scripts/can-up.sh`](scripts/can-up.sh) (run by `discodb2-can.service`):

1. `modprobe gs_usb` (belt-and-suspenders — the in-kernel **gs_usb** driver
   binds candleLight/UCAN firmware automatically on hotplug, VID `1d50` PID
   `606f`).
2. Waits up to ~10 s (bounded retry, no wall clock) for `$CAN_IFACE` to appear.
   If it never does, it exits with an actionable error pointing at
   `dmesg | grep -i gs_usb` and `lsusb`.
3. Brings the link down, then up with `bitrate=$CAN_BITRATE`,
   `restart-ms 100`, and **`listen-only on`** when `CAN_LISTEN_ONLY=1` (the
   default). With `CAN_LISTEN_ONLY=0` it logs a loud warning that the adapter
   may ACK/transmit on a live bus.

**Listen-only is enforced in two layers:** here at the link layer
(`ip link ... listen-only on`) **and** server-side in the backend regardless of
the link setting (DESIGN §4.1). The hardware adapter must be **candleLight /
gs_usb firmware** (not slcan) for the in-kernel driver to bind.

---

## 4. WiFi AP + WPA2 (`ap-setup.sh`) — and the dongle chipset check

### ⚠️ DONGLE CHIPSET VERIFICATION (#1 open validation question — DO THIS FIRST)

DESIGN §8 dev box: **Pi 1 B+ (4 USB) + a TP-Link USB WiFi dongle**. The Pi 1B+
has **no onboard WiFi**, so the AP runs on the dongle — and **not every dongle
can be an access point.** AP (a.k.a. "master") mode requires a chipset + driver
whose **nl80211** interface advertises **AP mode**, plus `hostapd` support for
that driver.

**Verify on real hardware BEFORE relying on it** — ⚠️ unverified for the
specific TP-Link dongle in the dev box:

```sh
lsusb                                          # note VID:PID (e.g. 2357:xxxx TP-Link)
iw list | sed -n '/Supported interface modes/,/^$/p'
#   -> the list MUST contain "* AP". If it shows only "managed"/"monitor",
#      this dongle CANNOT host the AP with stock hostapd.
```

**Known-bad pattern:** many cheap TP-Link dongles use **Realtek** chipsets
(`rtl8188eu`, `rtl8192cu`, `rtl8821au`, `rtl8812au`, …). Their out-of-tree
drivers historically do **not** advertise AP mode to nl80211/hostapd, or only
with a vendor-patched hostapd and a non-standard `driver=rtl871xdrv` line. The
in-kernel `rtl8xxxu` often lacks AP support entirely.

**Fallback if `AP` is absent:**
- Use a **known AP-capable dongle** — Atheros `ath9k_htc` (AR9271) is the
  reliable choice; or RTL8188EUS **only** with the patched `8188eu`/`rtl8188eus`
  DKMS driver + `driver=rtl871xdrv` in `hostapd.conf`.
- Or move to a **Pi 3B+** whose onboard radio (`brcmfmac`, `wlan0`) does AP mode
  out of the box.
- Set `AP_IFACE` in `discodb2.env` to whatever the working radio enumerates as
  (`wlan0` onboard, often `wlan1` for a USB dongle — check `iw dev` / `ip link`).

### What `ap-setup.sh` writes

[`scripts/ap-setup.sh`](scripts/ap-setup.sh) (run by `discodb2-ap.service`) is
idempotent and regenerates everything from the env file every run:

- **`/etc/hostapd/hostapd.conf`** — WPA2-PSK only (`wpa=2`, `wpa_key_mgmt=WPA-PSK`,
  `rsn_pairwise=CCMP`), `driver=nl80211`, `hw_mode=g` 2.4 GHz on `$AP_CHANNEL`,
  `country_code=$AP_COUNTRY`. **Refuses a passphrase outside 8..63 chars** (open
  WiFi rejected) and warns if it is still the `changeme-discodb2` default. Points
  `/etc/default/hostapd` at this config.
- **`/etc/dnsmasq.d/discodb2.conf`** — DHCP only (no world DNS): pool
  `$AP_DHCP_START..$AP_DHCP_END`, hands the Pi as gateway + DNS, and a **unicast**
  `address=/$MDNS_HOSTNAME.local/$AP_ADDR` record. This uses the **same**
  `$MDNS_HOSTNAME` (default `discodb`) Avahi publishes, so there is exactly **one**
  `.local` name — `discodb.local` — across dnsmasq and Avahi (see §5).
- **Static IP** on `$AP_IFACE` via a `dhcpcd.conf` dropin
  (`static ip_address=$AP_ADDR/24`, `nohook wpa_supplicant`).
- Sets the regulatory domain (`iw reg set`) and `rfkill unblock wlan`.

---

## 5. mDNS discovery (`avahi-setup.sh`)

So nobody types `192.168.4.1`, the box advertises itself via the **operating
system's** mDNS responder, **Avahi** — *not* backend code.
[`scripts/avahi-setup.sh`](scripts/avahi-setup.sh):

1. **Pins Avahi's host-name to `$MDNS_HOSTNAME` (`discodb`)** in
   `/etc/avahi/avahi-daemon.conf` → publishes an A-record for **`discodb.local`**
   on every interface. It touches *only* Avahi's config; the system hostname,
   `/etc/hosts`, and shell prompt are untouched, so the name is deterministic
   regardless of what Imager set.
2. **Materialises [`avahi/discodb2.service`](avahi/discodb2.service)** to
   `/etc/avahi/services/discodb2.service`, advertising the backend as a DNS-SD
   `_http._tcp` service on `$BACKEND_PORT` (syncing the port from the env file).
3. **Enables + reloads `avahi-daemon`** so it persists and picks up the changes.

**Why this costs the backend nothing:** `avahi-daemon` is the OS responder —
event-driven, idle on the hot path, zero per-frame work (key on a Pi 1B+). No
new long-running discodb2 process. If Avahi is ever unavailable, the **fixed AP
IP `192.168.4.1` is always the fallback**.

**Browser caveat:** a web page **cannot enumerate mDNS/DNS-SD** (no JS API). The
`_http._tcp` advert is for OS discovery tools (`avahi-browse -a`,
`dns-sd -B _http._tcp`, macOS Bonjour), **not** for the app to "find" the Pi.
The app does not need it: the OS resolves `.local` names, and both frontends
default their WebSocket to the same host that served the page
(`ws://<location.hostname>:8765/ws` — see
`frontend/cockpit/src/state/store.ts` and
`frontend/copilot/src/lib/store.svelte.ts`).

Verify on the Pi:

```sh
systemctl status avahi-daemon
avahi-resolve -n discodb.local      # -> discodb.local  192.168.4.1
avahi-browse -rt _http._tcp         # the "discodb2 on discodb" advert appears
```

---

## 6. Connecting a client + opening the UI

After provisioning and a reboot, from a phone/laptop:

1. **Join WiFi `discodb2`** (or your `AP_SSID`) with your passphrase.
2. **Open the cockpit UI** at **`http://discodb.local`** (or the fixed
   `http://192.168.4.1`). With `WEB_PORT=80` there is no port to type.

**How the UI is served (FIXED — was a gap):** the backend deliberately stays
thin and serves **only** `GET /health` and the `/ws` WebSocket; every other path
404s. The cockpit is therefore hosted by a **separate**, dependency-free unit,
[`discodb2-web.service`](systemd/discodb2-web.service), which runs Python's
stdlib `python3 -m http.server $WEB_PORT --directory $WEB_ROOT` (no extra apt or
pip packages — important on ARMv6). It serves the **pre-built** cockpit `dist/`.

The page's JS defaults its WebSocket to **the same host that served it** on
`:8765` (`ws://<location.hostname>:8765/ws` — see
`frontend/cockpit/src/state/store.ts`). So opening `http://discodb.local` auto
-connects to `ws://discodb.local:8765/ws` — no WS URL typing.

> **⚠️ `dist/` is built OFF-Pi and shipped.** Building the frontend on an ARMv6
> Pi 1B+ is impractical (no node toolchain, painful builds). Build it on your dev
> machine and ship the result in the repo so `install.sh` deploys it:
>
> ```sh
> cd frontend/cockpit && npm ci && npm run build   # -> frontend/cockpit/dist/
> ```
>
> `install.sh` warns at provisioning time if `$WEB_ROOT/index.html` is missing.
> If you ever need to change the build, copy the new `dist/` to `$WEB_ROOT` on
> the Pi and `sudo systemctl restart discodb2-web` (no rebuild on the Pi).
>
> **Dev alternative (still works):** run the Vite dev server
> (`cd frontend/cockpit && npm run dev`) on a laptop joined to the AP and point
> the app's **WS URL** at `ws://discodb.local:8765/ws`.

Backend reachability is independently verifiable regardless of the UI:
`http://discodb.local:8765/health` (or `http://192.168.4.1:8765/health`) returns
the JSON health snapshot.

> The two frontends in the repo are **`cockpit`** (fat client) and **`copilot`**
> (light client) — there is no "glance" frontend.

---

## Fixed infra bugs

Found by cross-checking the units/scripts against the actual backend
(`backend/discodb2_backend/`) and the docker entrypoint
(`infra/docker/entrypoint.sh`). **All four are now fixed in the provisioning
bundle** (the first two were crash-loop bugs). Recorded here for the audit trail.

1. **`discodb2-backend.service` launched the wrong module.** `ExecStart` ran
   `${BACKEND_PYTHON} -m backend ...`, but the package is **`discodb2_backend`**
   and there is no top-level `backend` module.
   - **Fix:** `ExecStart` now runs `${BACKEND_PYTHON} -m discodb2_backend ...`
     with `WorkingDirectory=/opt/discodb2/backend` (the package lives at
     `backend/discodb2_backend/`, so the import root is `backend/`). This mirrors
     the working docker entrypoint (`cd /app/backend && python -m discodb2_backend`).

2. **`--listen-only` was not a valid backend flag.** The unit passed
   `--listen-only`, but `config.py` defines no such argument — argparse exits
   non-zero and the service crash-loops.
   - **Fix:** removed `--listen-only`. The unit now passes only the flags
     `config.py` actually defines (`--source --bitrate --port --host`). Listen-only
     is enforced unconditionally server-side and at the link layer by `can-up.sh`,
     so nothing is lost. (The docker entrypoint also notes "there is NO
     `--listen-only` flag.")

3. **No frontend host on the Pi.** The thin backend serves only `/health` + `/ws`,
   so `http://discodb.local` served nothing.
   - **Fix:** added [`discodb2-web.service`](systemd/discodb2-web.service), a
     dependency-free static host (`python3 -m http.server $WEB_PORT --directory
     $WEB_ROOT`, default port 80) serving the **pre-built** cockpit `dist/`.
     `install.sh` enables it and warns if `dist/` is missing; `dist/` is built
     off-Pi and shipped (see §6). Avahi/dnsmasq/README URLs point at the UI host,
     not the `:8765` backend.

4. **Two competing `.local` names.** dnsmasq handed out `discodb2.local` while
   Avahi published `discodb.local` — near-identical, a foot-gun.
   - **Fix:** `ap-setup.sh` now derives the dnsmasq `address=/…/` record from
     `$MDNS_HOSTNAME` (default `discodb`), so both layers resolve the **single**
     name `discodb.local → $AP_ADDR`. When in doubt the **IP is the source of
     truth**.

⚠️ The fixes are reviewed against `config.py` + the docker entrypoint but the
units have **not** yet been run on hardware. Confirm them on the first Pi boot
(see the [Validation Checklist](#validation-checklist-run-on-real-hardware)).

---

## Validation Checklist (run on real hardware)

Run this on the dev box (Pi 1 B+ + TP-Link dongle). Tick each step; everything
here is **⚠️ unverified — validate on first hardware run** until checked off.

**A. Provisioning**
- [ ] `sudo sh /opt/discodb2/infra/pi-image/scripts/install.sh` completes without
      error; `/etc/discodb2/discodb2.env` exists (mode 600).
- [ ] Edited the env: real `AP_PASSPHRASE` (8..63), correct `AP_COUNTRY`,
      `AP_IFACE` matching the actual radio, `CAN_BITRATE`. For first boot set
      `BACKEND_SOURCE=sim`.
- [ ] `/opt/discodb2/.venv/bin/python` exists; venv has `websockets` (+ `python-can`).
- [ ] Built the cockpit OFF-Pi (`cd frontend/cockpit && npm run build`) and the
      shipped `dist/index.html` exists at `$WEB_ROOT`
      (`/opt/discodb2/frontend/cockpit/dist`); install warned if it was missing.

**B. WiFi dongle / AP**
- [ ] `iw list` shows **`* AP`** under "Supported interface modes" for the dongle
      (the #1 open question — if absent, switch dongle or use a Pi 3B+).
- [ ] `iw dev` shows `$AP_IFACE` in `type AP`.
- [ ] `systemctl status hostapd dnsmasq discodb2-ap` are active; AP **beacons**.
- [ ] A phone/laptop sees SSID `discodb2`, joins with WPA2, and gets a DHCP lease
      in `192.168.4.50–150`; the Pi answers at `192.168.4.1`.

**C. CAN bus**
- [ ] Adapter plugged in; `lsusb` shows `1d50:606f`; `dmesg | grep -i gs_usb`
      shows the bind.
- [ ] `ip -details link show can0` shows `state UP`, the configured `bitrate`,
      and **`LISTEN-ONLY`**.
- [ ] `candump can0` shows live frames (with the vehicle/bus connected).
- [ ] `systemctl status discodb2-can` is active (`RemainAfterExit`).

**D. Backend**
- [ ] `systemctl status discodb2-backend` is active;
      `journalctl -u discodb2-backend -b` shows no crash-loop (confirms the
      [fixed](#fixed-infra-bugs) module + flag bugs hold on hardware).
- [ ] `curl http://192.168.4.1:8765/health` returns JSON; from a joined client
      `http://discodb.local:8765/health` also returns it.

**E. Web host (cockpit UI)**
- [ ] `systemctl status discodb2-web` is active; no crash-loop.
- [ ] From a joined client `http://discodb.local` (or `http://192.168.4.1`)
      loads the cockpit (not a 404 / directory listing).

**F. mDNS**
- [ ] On the Pi: `avahi-resolve -n discodb.local` → `192.168.4.1`;
      `avahi-browse -rt _http._tcp` shows the `discodb2 on discodb` advert.
- [ ] From a client: `ping discodb.local` resolves (macOS/Linux/Win10+; some
      Android cannot resolve `.local` → use the IP).

**G. End-to-end frame flow into the cockpit**
- [ ] Opening `http://discodb.local` loads the cockpit, which auto-connects to
      `ws://discodb.local:8765/ws`; **Connect** succeeds and the `hello`
      handshake registers as `cockpit`.
- [ ] **Start** with `sim` → frames render (proves the UI ↔ backend path with
      zero hardware).
- [ ] **Start** with `socketcan` → live frames from `can0` render in the cockpit
      (proves the full chain: bus → can0 listen-only → backend → WS → cockpit).

---

## Troubleshooting

```sh
systemctl status discodb2-can discodb2-ap discodb2-backend discodb2-web
journalctl -u discodb2-backend -b           # backend logs since this boot
journalctl -u discodb2-web -b               # static web host logs since this boot
ip -details link show can0                  # confirm "can ... LISTEN-ONLY ... state UP"
iw dev                                       # confirm the AP iface is in type AP
sudo hostapd -dd /etc/hostapd/hostapd.conf   # foreground hostapd debug if AP won't start
candump can0                                 # raw frames (sanity-check the bus)
systemctl status avahi-daemon                # mDNS responder (discodb.local)
avahi-browse -rt _http._tcp                  # confirm the backend advert is published
```

- **`can0` missing:** `dmesg | grep -i gs_usb`; check `lsusb` shows `1d50:606f`.
  The adapter must be candleLight/gs_usb firmware (not slcan).
- **AP won't beacon:** almost always the dongle chipset caveat (§4), or
  `AP_COUNTRY` unset (the radio refuses to transmit without a regulatory domain).
- **Backend crash-loops on start:** historically the `-m backend` /
  `--listen-only` bugs — now [fixed](#fixed-infra-bugs). If it recurs, confirm
  `ExecStart` runs `-m discodb2_backend` with `WorkingDirectory=/opt/discodb2/backend`
  and passes no flag absent from `config.py`.
- **Phone connects but no UI:** check `systemctl status discodb2-web` and that
  `$WEB_ROOT/index.html` exists (build the cockpit OFF-Pi and ship `dist/` — §6).
  A directory listing instead of the app means `dist/` is missing/empty.
  `/health` on `:8765` confirms the backend independently.
- **`discodb.local` won't resolve:** the fixed IP `192.168.4.1` always works.
  Check `systemctl status avahi-daemon` and `avahi-resolve -n discodb.local`.
  Re-run `sudo sh .../scripts/avahi-setup.sh` if the advert is missing.
