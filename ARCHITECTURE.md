# Architecture

The application has two main operating modes:

- `IS_WEB` not set (default), where the javascript client in the browser talks to an Express server (HTTP + websocket), which drives one or more plotters (AxiDraws, HP-GL plotters) using NodeSerialPort.  This will work for most use cases.
- `IS_WEB=TRUE`, where only static files are served. The javascript client talks directly to the EBB using the WebSerial API. This mode is ideal for hosting on a public site where people can access it from their browser to control an AxiDraw machine connected to their computer.

There's a third operation mode, which is sending individual instructions to the AxiDraw machine, without displaying any web client or starting a web server. This can be used for development and testing.

## Important Files

- [`src/cli.ts`](src/cli.ts) The main entry point. When called with no commands, it starts an Express Server that serves the compiled static code. Alternatively, it can be used to execute individual instructions on the Axi machine.
- [`src/server.ts](src/server.ts) The Express Server definition. It serves these main paths:
  - `/` The static files for compiled UI code.
  - `/plotters` and `/plotters/<id>/plot`, `/pause`, `/resume`, `/cancel` (see [`src/plotter-routes.ts`](src/plotter-routes.ts)) to manage the plotters and plot on each.
  - `/plot`, `/cancel`, `/pause`, `/resume` and `/plot/status`: the same for the first plotter, as before saxi drove several.
  - It also keeps a WebSocket connection with the UI to track drawing progress, and receive some motion instructions. Messages carry the plotter id; a client gets those of the plotter it subscribed to (`{c: "subscribe", p: {plotter}}`), the first one by default.
  - `/cameras`, `/timelapse` and `/timelapses` (see [`src/camera-routes.ts`](src/camera-routes.ts)) for the camera tab.
- [`src/plotter.ts`](src/plotter.ts) `Plotter`: one plotter's connection (kept up, re-established when it drops, HP-GL baud rate detection) and its plot loop with pause and cancel, driving a [`PlotterDriver`](src/plotter-driver.ts). `EbbDriver` drives an EiBotBoard through [`src/ebb.ts`](src/ebb.ts).
- [`src/plotter-manager.ts`](src/plotter-manager.ts) `PlotterManager`: the plotters, persisted to `<dataDir>/plotters.json` (without it, one AxiDraw from `--device`/`--hardware`), finding AxiDraws by USB serial number without two plotters taking the same one, and listing the server's serial ports.
- [`src/hpgl-plotter.ts`](src/hpgl-plotter.ts) `HpglPlotter`: the driver for HP-GL plotters such as the HP 7475A. It paces the data in software: each chunk ends with an output instruction (OA/OC) whose answer arrives once the plotter has parsed everything before it, and at most 900 bytes (of its 1024-byte buffer) may be unanswered. The answers also report where the plotter is.
- [`src/hpgl.ts`](src/hpgl.ts) HP-GL encoding shared by the server and the UI: the 7475A's paper frames, the paper-to-plotter coordinate transform and `HpglEncoder`, which turns plan motions into PU/PD instructions clipped to the plotting area.
- [`src/hpgl-sim.ts`](src/hpgl-sim.ts) and [`src/sim-ports.ts`](src/sim-ports.ts) A simulated HP 7475A and EBB on fake serial ports, for the "simulated" port and the tests.
- [`src/plotter-types.ts`](src/plotter-types.ts) Types shared by the server and the UI for plotters, their status and jobs.
- [`src/plotter-ui.tsx`](src/plotter-ui.tsx) The "plotters" tab (overview of every plotter and its job, the plotter form) and the plotter switcher of the plot view.
- [`src/ui.tsx`](src/ui.tsx) The bulk of the React UI, handles the logic for rendering and interaction. It uses the `BaseDriver` interface to pass instructions to the Express Server. Important parts are:
  - `Root` holds the connection to the server, the list of plotters, the selected plotter and the tabs.
  - `PlotView` contains the plot tab for one plotter (it is keyed by plotter, so switching plotters gives each its own state), and handles most of the interaction events, including the loading of a new SVG.
  - The control panel has all the config settings, grouped in components: `PenHeight`, `MotorControl`, `PaperConfig`, etc.
  - `reducer` manages state and handles the UI interaction flow - i.e. disabling/enabling controls when plotting.
- [`src/drivers.ts`](src/drivers.ts) Interface between UI and Axi machine.  `SaxiDriver`, which uses an intermediate server and NodeSerialPort, and `WebSerialDriver`, which uses WebSerial, are both implementations of `BaseDriver`.
- [`src/planning.ts`](src/planning.ts) Most of the logic of interpreting an SVG-like object and converting it into a `Plan` of machine instructions to execute. It defines attribute interfaces that are used both in the UI and the server. `Device` describes each machine; for HP-GL plotters (`hp7475a`) plans are in plotter units and only order the paths and estimate the timing, since the plotter plans its own motion.
- [`src/massager.ts`](src/massager.ts) Some higher-level transformations that can be done like rotating.
- [`src/camera.ts`](src/camera.ts) Server-side cameras: frame sources (ffmpeg for local devices and RTSP, `rpicam-vid` for the Pi camera, plain HTTP for snapshot/MJPEG URLs), an MJPEG frame parser, and `CameraManager` which persists the camera list to `<dataDir>/cameras.json`. A camera only streams while a preview client or a recording needs it.
- [`src/timelapse.ts`](src/timelapse.ts) `TimelapseRecorder` keeps one recording per plotter, of the enabled cameras assigned to it (or to every plotter), capturing frames into `<dataDir>/timelapses/<id>/<camera>/`, each camera on its own trigger or the default one, driven by hooks the server calls from its plot loop (`plotStarted`, `plotterBusy`, `plotMotion`, `plotEnded`) or by manual start/snap/stop. `PlotClock` works out when the plotter actually gets to the motions it is sent (the EBB queues them), for the pen triggers. It renders MP4s with ffmpeg (one per camera plus a stacked composite, lined up by the moments in `timeline.txt`).
- [`src/camera-devices.ts`](src/camera-devices.ts) Lists the USB capture devices of a Linux server for the camera form: video nodes from sysfs, their formats and resolutions from `ffmpeg -list_formats`, and the stable `/dev/v4l/by-id` or `by-path` link to store instead of `/dev/videoN`.
- [`src/camera-routes.ts`](src/camera-routes.ts) The HTTP API for the above.
- [`src/camera-types.ts`](src/camera-types.ts) Types and defaults shared by the server and the UI.
- [`src/camera-ui.tsx`](src/camera-ui.tsx) The React "camera" tab: live multi-camera grid (polled stills drawn on a canvas), camera and timelapse settings, recording controls and the timelapse library. It only talks to the REST API and does not touch the plotter state; `Root` in `ui.tsx` keeps the plot view mounted but hidden while the camera tab is shown.

## When dropping an SVG on the Drawing Area

On `ui.tsx`:

1. The event `ondrop` is triggered on the `Root` component.
2. It reads the file as a string, and calls the `readSvg` function.
3. The `readSvg` function parses the text as an DOM object to call the `flatten-svg` library. It converts it into a list of `Line`s.
4. Each line is converted to `Path` - a list of `Vec2`.
5. The `setPaths` function assigns the result in `paths`, and makes a groups of strokes by layers.
6. Then the paths are converted into a `Plan` - parameterized by the `PlanOptions` on the `usePlan` function`.
  a. It spawns a background `Worker` in `background-planner.ts`
  b. It calls `replan` on `massager.ts` to apply higher level tranformations.
  b. Which in turns calls `plan` on `planning.ts` to transform a list of lines and parameters into a list of `PenMotion`.
7. The plan gets stored in the state of the `Root` component.
