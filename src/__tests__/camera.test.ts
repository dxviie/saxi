import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  Camera,
  CameraConfigError,
  CameraManager,
  FrameSource,
  JpegStreamParser,
  jpegDimensions,
  UrlSource,
  validateCameraConfig,
} from "../camera.js";
import type { CameraConfig } from "../camera-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JPEG = readFileSync(path.join(__dirname, "fixtures", "frame.jpg"));

/** A JPEG whose APP1 segment embeds a thumbnail containing an EOI marker. */
function jpegWithThumbnail(): Buffer {
  const thumb = JPEG; // any complete JPEG; it ends with FF D9
  const payload = Buffer.concat([Buffer.from("Exif\0\0"), thumb]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.alloc(2), payload]);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([JPEG.subarray(0, 2), app1, JPEG.subarray(2)]);
}

/** Start an HTTP server serving `JPEG` as a snapshot at / and as an MJPEG stream at /stream. */
function startImageServer(): Promise<{ server: http.Server; url: string; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.url === "/stream") {
      res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame" });
      const send = () => {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG.length}\r\n\r\n`);
        res.write(JPEG);
        res.write("\r\n");
      };
      const timer = setInterval(send, 20);
      send();
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (req.url === "/text") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not an image");
      return;
    }
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(JPEG);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, hits: () => hits });
    });
  });
}

function collectFrames(source: FrameSource, count: number, timeoutMs = 5000): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const frames: Buffer[] = [];
    const timer = setTimeout(() => {
      source.stop();
      reject(new Error(`only got ${frames.length}/${count} frames`));
    }, timeoutMs);
    source.on("frame", (f: Buffer) => {
      frames.push(f);
      if (frames.length === count) {
        clearTimeout(timer);
        source.stop();
        resolve(frames);
      }
    });
    source.start();
  });
}

describe("JPEG helpers", () => {
  test("jpegDimensions reads the SOF segment", () => {
    expect(jpegDimensions(JPEG)).toEqual({ width: 64, height: 48 });
    expect(jpegDimensions(Buffer.from("nope"))).toBeNull();
  });

  test("parser splits a concatenated stream into frames", () => {
    const parser = new JpegStreamParser();
    const frames = parser.push(Buffer.concat([JPEG, JPEG, JPEG]));
    expect(frames).toHaveLength(3);
    for (const f of frames) expect(f.equals(JPEG)).toBe(true);
  });

  test("parser handles frames split across arbitrary chunk boundaries", () => {
    const stream = Buffer.concat([
      Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n"),
      JPEG,
      Buffer.from("\r\n--frame\r\n"),
      JPEG,
    ]);
    for (const chunkSize of [1, 7, 100, 1000]) {
      const parser = new JpegStreamParser();
      const frames: Buffer[] = [];
      for (let i = 0; i < stream.length; i += chunkSize) {
        frames.push(...parser.push(stream.subarray(i, i + chunkSize)));
      }
      expect(frames, `chunk size ${chunkSize}`).toHaveLength(2);
      expect(frames[1].equals(JPEG)).toBe(true);
    }
  });

  test("parser is not fooled by an EOI inside an embedded thumbnail", () => {
    const withThumb = jpegWithThumbnail();
    const frames = new JpegStreamParser().push(Buffer.concat([withThumb, JPEG]));
    expect(frames).toHaveLength(2);
    expect(frames[0].length).toBe(withThumb.length);
    expect(jpegDimensions(withThumb)).toEqual({ width: 64, height: 48 });
  });
});

describe("camera configuration", () => {
  test("fills defaults and validates", () => {
    const cfg = validateCameraConfig(
      { name: " Top ", kind: "url", source: "http://cam.local/shot.jpg", fps: "1" },
      "abc",
    );
    expect(cfg).toMatchObject({
      id: "abc",
      name: "Top",
      kind: "url",
      fps: 1,
      rotate: 0,
      enabled: true,
      resolution: "",
    });
  });

  test("rejects bad input", () => {
    const bad = (input: object) => expect(() => validateCameraConfig(input, "x")).toThrow(CameraConfigError);
    bad({ kind: "webcam", source: "/dev/video0" });
    bad({ kind: "url", source: "ftp://x" });
    bad({ kind: "url", source: "" });
    bad({ kind: "rtsp", source: "http://x" });
    bad({ kind: "url", source: "http://x", fps: 99 });
    bad({ kind: "url", source: "http://x", rotate: 45 });
    bad({ kind: "url", source: "http://x", resolution: "big" });
    if (process.platform === "linux") bad({ kind: "device", source: "/etc/passwd" });
  });
});

describe("sources", () => {
  let images: Awaited<ReturnType<typeof startImageServer>>;
  beforeAll(async () => {
    images = await startImageServer();
  });
  afterAll(() => {
    images.server.close();
  });

  test("UrlSource polls a snapshot URL at the configured rate", async () => {
    const frames = await collectFrames(new UrlSource(`${images.url}/snap.jpg`, 20), 3);
    expect(frames.every((f) => f.equals(JPEG))).toBe(true);
  });

  test("UrlSource consumes an MJPEG stream", async () => {
    const frames = await collectFrames(new UrlSource(`${images.url}/stream`, 30), 3);
    expect(frames.every((f) => f.equals(JPEG))).toBe(true);
  });

  test("UrlSource reports non-image responses as errors", async () => {
    const source = new UrlSource(`${images.url}/text`, 10);
    const error = await new Promise<Error>((resolve) => {
      source.on("error", resolve);
      source.start();
    });
    source.stop();
    expect(error.message).toMatch(/did not return a JPEG/);
  });

  test("Camera starts its source on demand and stops it when released", async () => {
    let starts = 0;
    let stops = 0;
    class FakeSource extends FrameSource {
      private timer: NodeJS.Timeout | null = null;
      protected run() {
        starts += 1;
        this.timer = setInterval(() => this.emit("frame", JPEG), 5);
      }
      protected halt() {
        stops += 1;
        if (this.timer) clearInterval(this.timer);
      }
    }
    const config: CameraConfig = validateCameraConfig({ kind: "url", source: "http://x/", name: "fake" }, "fake");
    const camera = new Camera(config, () => new FakeSource());
    expect(camera.status.state).toBe("idle");
    const release = camera.retain();
    const frame = await camera.getFrame({ fresh: true });
    expect(frame.equals(JPEG)).toBe(true);
    expect(camera.status).toMatchObject({ state: "live", width: 64, height: 48 });
    expect(starts).toBe(1);
    release();
    // still running until the idle timeout, but a close stops it immediately
    expect(stops).toBe(0);
    camera.close();
    expect(stops).toBe(1);
    expect(camera.status.state).toBe("idle");
  });

  test("CameraManager persists cameras to disk", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "saxi-cams-"));
    const manager = new CameraManager(dir);
    const added = manager.add({ name: "Left", kind: "url", source: `${images.url}/snap.jpg`, fps: 5 });
    expect(manager.list()).toHaveLength(1);
    manager.close();

    const reloaded = new CameraManager(dir);
    expect(reloaded.list().map((c) => c.id)).toEqual([added.id]);
    expect(reloaded.update(added.id, { name: "Right" })?.name).toBe("Right");
    expect(reloaded.remove(added.id)).toBe(true);
    expect(reloaded.list()).toHaveLength(0);
    reloaded.close();
  });
});
