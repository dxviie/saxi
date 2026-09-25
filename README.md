# saxi
##### make plot good

saxi is a tool for interacting with the [AxiDraw
drawing machine](https://axidraw.com/) by Evil Mad Scientist. It comes with an
easy-to-use interface, and is exactingly precise.

- automatically scales & centers your drawing to fit on the paper
- minimizes pen-up travel time by reordering & reversing paths
- uses a custom motion planning algorithm (inspired by [axi](https://github.com/fogleman/axi)) that's smooth & fast
- automatically splits apart layers based on SVG stroke colors or group IDs
- has a web-based UI, so there's no need to muck around with installing X11 and Inkscape
- can run on a Raspberry Pi or similar, so you don't need to be tethered to your plotter while it plots

![a screenshot of the saxi user interface](docs/saxi.png)

### Installation

#### For Raspberry Pi 2 / 3 / 4 / 5

1. **Install Node.js (if not already installed):**

```bash
$ curl -sL https://deb.nodesource.com/setup_20.x | sudo -E bash -
$ sudo apt-get install -y nodejs
```

2. **Install `saxi` globally:**

```bash
$ sudo npm install -g saxi
```

If you encounter an `EACCES` error when installing the package globally, see [Resolving EACCES permissions errors when installing packages globally](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).

---

#### For Raspberry Pi Zero / 1 (armv6l)

The official Node.js builds don’t support armv6l. Use an unofficial build:

1. **Download and extract Node.js v20 for armv6l:**

```bash
$ wget https://unofficial-builds.nodejs.org/download/release/v20.5.1/node-v20.5.1-linux-armv6l.tar.xz
$ tar xf node-v*-armv6l.tar.xz
$ export PATH=$PATH:$PWD/node-v*-linux-armv6l/
```

2. **Install `saxi`:**

```bash
$ npm install -g saxi
```

If you encounter an `EACCES` error when installing the package globally, see [Resolving EACCES permissions errors when installing packages globally](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).

---

### Usage

Start the `saxi` server from the terminal:

```bash
$ saxi
Server listening on http://0.0.0.0:9080
Connecting to EBB on /dev/tty.usbmodem1461
```

Then open a web browser:

Go to `http://localhost:9080` if you're using the same computer where saxi is running.

Go to `http://<computer-ip>:9080` if you're on a different device.
(You can find the IP address by running `hostname -I` on the computer running saxi.)

---

### Running `saxi` over SSH

If you're connecting to your Raspberry Pi via SSH, it’s a good idea to keep the `saxi` server running inside a `tmux` session so it stays active even if your SSH session disconnects.

#### Install `tmux` (if not installed)

```bash
$ sudo apt-get install -y tmux
```

#### Start a `tmux` session and run `saxi`

```bash
$ tmux new -s saxi
$ saxi
```

To detach from the session (leaving it running), press:

```
Ctrl + b, then d
```

To reattach later:

```bash
$ tmux attach -t saxi
```

To list sessions:

```bash
$ tmux ls
```

To terminate session:

```bash
$ tmux kill-session -t saxi
```

---

If you want `saxi` to run at boot on the Pi you can use a systemd unit file and enable the service:

```bash
sudo tee /lib/systemd/system/saxi.service <<EOF
[Unit]
Description=Saxi
After=network.target

[Service]
ExecStart=saxi
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable saxi.service
```

To watch the logs while it is running, use:
```bash
journalctl -f -u saxi
```

#### Raspberry Pi Zero OTG

![Pi Zero on an AxiDraw with a Y-shaped USB cable](docs/pi-zero.jpg)

For the Pi Zero you can make a USB "OTG" cable out of two Micro-B cables and two 0.1" headers
to tap into the AxiDraw's 5V servo supply to power the Pi.  This makes for a more compact
installation without the need for an additional wall-wart.


```
           +------ Center pin on servo rail
           | +---- Ground pin on servo rail
           | |
           | |
Red   -----+-|---- Red
Black -------+---- Black
White ------------ White
Green ------------ Green (sometimes Blue)
```

The Pi will also need to have the `dr_mode=host` parameter set in
`config.txt` to force host mode, since normal USB Micro cables do not
include the `ID` pin that would be used to signal that it is an OTG
connection.

```
echo dtoverly=dwc2,dr_mode=host | sudo tee -a /boot/config.txt
```


#### Cameras & timelapses

The **camera** tab (next to **plot** in the top left) gives you a live view of
one or more cameras pointed at the plotter, records timelapses of your plots and
renders them to MP4, much like the camera integration of a 3D printer.

Cameras are read by the saxi server, so they can be anywhere the server can
reach:

| type | source | needs |
|---|---|---|
| USB / local camera | picked from the connected cameras or `/dev/video0` (Linux), a device index such as `0` (macOS), the device name (Windows) | `ffmpeg` |
| Raspberry Pi camera module | (none) | `rpicam-vid` / `libcamera-vid` (Raspberry Pi OS) |
| HTTP snapshot / MJPEG | a JPEG snapshot URL, or an MJPEG stream (IP cameras, phone camera apps, ESP32-CAM, mjpg-streamer, another Pi running [ustreamer](https://github.com/pikvm/ustreamer)…) | nothing |
| RTSP stream | `rtsp://…` | `ffmpeg` |

On a Raspberry Pi, install ffmpeg with `sudo apt install ffmpeg`. Without it,
HTTP cameras still work but USB/RTSP cameras and video rendering are unavailable.

On Linux, the camera form lists the USB cameras connected to the saxi server,
with the input formats and resolutions each one supports, so you don't have to
work out which `/dev/videoN` to use (most webcams create two, and only one of
them delivers video). A camera you pick is stored by its `/dev/v4l/by-id/…`
link, or by its `/dev/v4l/by-path/…` USB port link for identical cameras
without a serial number, so it keeps working when the numbers change after
replugging or a reboot. `mjpeg` is preselected when a camera offers it:
uncompressed video needs so much USB bandwidth that several uncompressed
cameras often cannot run at once. Pick “other…” to enter a device path yourself.

A camera only streams while somebody is looking at it or a recording is in
progress, and stops again after a few seconds of inactivity, so an idle camera
does not cost any CPU. The live view polls one still per camera at a low rate
(1 fps by default, adjustable in the tab) so it stays usable over Wi-Fi from a
phone; `/cameras/<id>/stream.mjpeg` offers a continuous MJPEG stream for other
tools. Set the camera's **capture fps** to how often it should sample frames:
2–5 fps is plenty for timelapses and keeps a Pi cool.

**Timelapses.** Enable **record every plot** and every plot is recorded from all
enabled cameras at once, starting with a frame of the blank page and ending with
the finished drawing. Frames are triggered by

- **every pen lift** (with a minimum gap between frames), which gives the cleanest
  frames because the pen is off the paper,
- a **fixed interval**, or
- a **target frame count**, where the interval is derived from the estimated plot
  duration so that every plot yields a video of roughly the same length.

You can also start a recording by hand and take snapshots whenever you like.
When a recording ends it is rendered (if ffmpeg is available) to one MP4 per
camera plus a side-by-side composite of all cameras; fps, quality, x264 preset,
post-roll and composite are configurable and any recording can be re-rendered
later with different settings. Rendering on a Raspberry Pi is slow, so pick a fast
preset there or copy the frames elsewhere.

Everything is stored under `~/.saxi` (override with `--data-dir` or
`SAXI_DATA_DIR`): `cameras.json`, `timelapse.json` and one directory per
recording in `timelapses/` containing `<camera>/frame-000001.jpg …`, the rendered
videos in `renders/` and a `timelapse.json` describing the recording. Keep an eye
on free disk space: a long plot with several full-resolution cameras adds up.

The camera tab is only available when running the saxi server (not on the
WebSerial-only web build), since the cameras are attached to the server.

#### CORS

If you want to connect to saxi from a web page that isn't served by saxi
itself, you'll need to enable
[CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS), otherwise
GET/POST requests will be denied by the browser. CORS is disabled by default as
a security precaution, but if you need it it's available. Just launch saxi with
the `--enable-cors` flag.

### Info

saxi makes use of the low-level `LM` command introduced in EBB firmware version
2.5.3 to carry out highly accurate constant-acceleration motion plans. If your
AxiDraw is running an older version of the firmware, saxi will fall back to the
less-accurate (but still pretty accurate) `XM` command.

To check what version of the EBB firmware your AxiDraw is running, run `saxi --firmware-version`:

```bash
$ saxi --firmware-version
EBBv13_and_above EB Firmware Version 2.5.3
```

To upgrade your AxiDraw's firmware, see [here](https://github.com/evil-mad/EggBot/tree/master/EBB_firmware).

### Developing

To work on saxi, you can clone this repo and then run `npm start`:

```sh
$ git clone https://github.com/alexrudd2/saxi
$ cd saxi
$ npm run start
```

This will not watch local files for changes. If you change the server code, you'll need to restart manually.

### Credits

saxi's motion planning algorithm is heavily inspired by Michael Fogleman's
[axi](https://github.com/fogleman/axi) project.

saxi's UI would be an ugly mess if it weren't for [@kylestetz](https://github.com/kylestetz)'s discerning eye.

Thanks to [Evil Mad Scientist](http://www.evilmadscientist.com/) for designing
and building such a lovely machine!

---

## Made with saxi

These images were plotted by folks using saxi. If you'd like to add something you've made here, [shoot me an email](mailto:nornagon@nornagon.net)!

<table>
  <tbody>
    <tr>
      <td width=300>
        <a href="https://www.instagram.com/p/B9hFx9KFOwG/"><img width="272" src="https://user-images.githubusercontent.com/172800/80814353-9760ce00-8b80-11ea-8a94-64e13c33a7bc.jpg" alt="Plotted image by @targz" /></a>
        <p>by <strong>Julien Terraz (<a href="https://www.instagram.com/targz/">@targz</a>)</strong></p>
      </td>
      <td width=300>
        <a href="https://github.com/abey79/vpype-explorations"><img width="272" src="https://user-images.githubusercontent.com/172800/80814313-81530d80-8b80-11ea-963a-9ea337f2c6a2.jpg" alt="Plotted image by @abey79" /></a>
        <p>by <strong>Antoine Beyeler (<a href="https://twitter.com/abey79">@abey79</a>)</strong></p>
      </td>
      <td width=300>
        <a href="https://twitter.com/MAKIO135/status/1253334618243125256"><img width="272" src="https://user-images.githubusercontent.com/172800/80814775-4ef5e000-8b81-11ea-896c-e7522d4c38d1.jpg" alt="Plotted image by @MAKIO135" /></a>
        <p>by <strong>Lionel Radisson (<a href="https://twitter.com/MAKIO135">@MAKIO135</a>)</strong></p>
      </td>
    </tr>
    <tr>
      <td width=300>
        <a href="https://www.instagram.com/p/B4iixy7gDB9/"><img width="272" src="https://user-images.githubusercontent.com/172800/80815693-faebfb00-8b82-11ea-81a3-24f825b405ce.jpg" alt="Plotted image by @daniel_feles" /></a>
        <p>by <strong>Daniel Feles (<a href="https://www.instagram.com/daniel_feles/">@daniel_feles</a>)</strong></p>
      </td>
      <td width=300>
      </td>
      <td width=300>
      </td>
    </tr>
  </tbody>
</table>
