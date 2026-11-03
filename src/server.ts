/**
 * Backend web server for controlling the plotters.
 * Serve both the front end UI as static files - made with React, and backend
 * API for controlling the plotters (see plotter-routes.ts) and cameras (camera-routes.ts).
 * Keep open web sockets to the front end for real-time updates.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoDetect } from "@serialport/bindings-cpp";
import type { PortInfo } from "@serialport/bindings-interface";
import cors from "cors";
import express from "express";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { mountCameraRoutes } from "./camera-routes.js";
import { CameraManager } from "./camera.js";
import { EBB, type Hardware } from "./ebb.js";
import type { Plotter } from "./plotter.js";
import { PlotterManager } from "./plotter-manager.js";
import { mountPlotterRoutes } from "./plotter-routes.js";
import { SerialPortSerialPort } from "./serialport-serialport.js";
import { TimelapseRecorder } from "./timelapse.js";

type Com = string;

/** Where saxi keeps camera settings and timelapse recordings unless told otherwise. */
export function defaultDataDir(): string {
  return process.env.SAXI_DATA_DIR || path.join(os.homedir(), ".saxi");
}

interface Client {
  ws: WebSocket;
  /** The plotter this client watches. */
  plotter: string;
}

/**
 * Start the express server.
 * @param port
 * @param hardware model of the AxiDraw saxi starts with when no plotters are configured
 * @param com serial port of the first AxiDraw (default: the first one found)
 * @param enableCors
 * @param maxPayloadSize
 * @param dataDir directory for plotter and camera settings and timelapse recordings
 * @returns
 */
export async function startServer(
  port: number,
  hardware: Hardware = "v3",
  com: Com = "",
  enableCors = false,
  maxPayloadSize = "200mb",
  dataDir: string = defaultDataDir(),
) {
  const app = express();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use("/", express.static(path.join(__dirname, "..", "ui")));
  app.use(express.json({ limit: maxPayloadSize }));
  if (enableCors) {
    app.use(cors());
  }
  // Cameras and timelapse recording (see camera.ts / timelapse.ts)
  const cameras = new CameraManager(dataDir);
  const timelapse = new TimelapseRecorder(cameras, dataDir);
  // Web and Socket server
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const clients = new Set<Client>();

  /** Sends a plotter's message to the clients watching it. */
  function emit(plotterId: string, message: Record<string, unknown>) {
    const text = JSON.stringify({ ...message, plotter: plotterId });
    for (const client of clients) {
      if (client.plotter !== plotterId) continue;
      try {
        client.ws.send(text);
      } catch (e) {
        console.warn(e);
      }
    }
  }

  const plotters = new PlotterManager(
    dataDir,
    { recorder: timelapse, emit },
    { defaultPort: com || undefined, defaultHardware: hardware },
  );

  mountCameraRoutes(app, cameras, timelapse, {
    plotting: () =>
      plotters
        .all()
        .filter((p) => p.isPlotting)
        .map((p) => p.id),
    defaultId: () => plotters.default().id,
    name: (id) => plotters.get(id)?.config.name,
  });
  mountPlotterRoutes(app, plotters);

  wss.on("connection", (ws) => {
    const client: Client = { ws, plotter: plotters.default().id };
    clients.add(client);
    const send = (plotter: Plotter) => {
      for (const message of plotter.initialMessages()) {
        ws.send(JSON.stringify({ ...message, plotter: plotter.id }));
      }
    };
    ws.on("message", (message) => {
      let msg: { c?: string; p?: Record<string, unknown> };
      try {
        msg = JSON.parse(message.toString());
      } catch {
        return;
      }
      const target = plotters.get(String(msg.p?.plotter ?? client.plotter)) ?? plotters.default();
      const run = (action: Promise<unknown>) => {
        action.catch((e) => console.error(`${target.config.name}: ${(e as Error).message}`));
      };
      switch (msg.c) {
        case "ping":
          ws.send(JSON.stringify({ c: "pong" }));
          break;
        case "subscribe": {
          // watch another plotter
          const plotter = plotters.get(String(msg.p?.plotter));
          if (plotter) {
            client.plotter = plotter.id;
            send(plotter);
          }
          break;
        }
        case "limp":
          run(target.limp());
          break;
        case "setPenHeight":
          run(target.setPenHeight(Number(msg.p?.height), Number(msg.p?.rate)));
          break;
        case "selectPen":
          run(target.selectPen(Number(msg.p?.pen)));
          break;
        case "changeHardware":
          try {
            plotters.update(target.id, { hardware: msg.p?.hardware });
          } catch (e) {
            console.error((e as Error).message);
          }
          break;
      }
    });

    // send starting params to clients
    send(plotters.default());

    ws.on("close", () => {
      clients.delete(client);
    });
  });

  server.on("close", () => {
    timelapse.close();
    cameras.close();
    void plotters.close();
  });

  return new Promise<http.Server>((resolve) => {
    server.listen(port, async () => {
      const { family, address, port } = server.address() as AddressInfo;
      const addr = `${family === "IPv6" ? `[${address}]` : address}:${port}`;
      console.log(`Server listening on http://${addr}`);
      await plotters.start();
      resolve(server);
    });
  });
}

async function tryOpen(com: Com) {
  const port = new SerialPortSerialPort(com);
  await port.open({ baudRate: 9600 });
  if (!port.readable || !port.writable) {
    throw new Error("Serial port opened but readable/writable streams are unavailable");
  }
  return port;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEBB(p: PortInfo): boolean {
  return (
    p.manufacturer === "SchmalzHaus" ||
    p.manufacturer === "SchmalzHaus LLC" ||
    (p.vendorId === "04D8" && p.productId === "FD92")
  );
}

async function listEBBs() {
  const Binding = autoDetect();
  const ports = await Binding.list();
  return ports.filter(isEBB).map((p: { path: string }) => p.path);
}

export async function waitForEbb(): Promise<Com> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ebbs = await listEBBs();
    if (ebbs.length) {
      return ebbs[0];
    }
    await sleep(5000);
  }
}

export async function connectEBB(hardware: Hardware, device?: string): Promise<EBB | null> {
  const dev = device ?? (await listEBBs())[0];
  if (!dev) return null;

  const port = await tryOpen(dev);
  return await EBB.create(port, hardware);
}
