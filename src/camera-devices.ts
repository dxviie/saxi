/**
 * Discovery of the capture devices attached to the saxi server, so the camera
 * form can offer the connected cameras, and the formats and resolutions each
 * one supports, instead of making people find the right /dev/videoN.
 *
 * Linux only for now. Devices come from sysfs and their formats from ffmpeg,
 * which USB cameras need anyway. Only USB devices are listed: that leaves out
 * the codec, ISP and CSI nodes of a Raspberry Pi (its camera module has the
 * libcamera kind) and the internal nodes of laptop MIPI cameras.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  type CameraConfig,
  sortResolutions,
  type VideoDevice,
  type VideoDeviceFormat,
  type VideoDevicesResponse,
} from "./camera-types.js";

/**
 * Device paths accepted for local cameras on Linux: /dev/videoN, or one of the links
 * udev keeps in /dev/v4l/by-id (per camera) and /dev/v4l/by-path (per USB port).
 */
export const LINUX_DEVICE_PATH = /^\/dev\/(video\d+|v4l\/by-(id|path)\/[^/\s.][^/\s]*)$/;

// One line per format, for example
//   [video4linux2,v4l2 @ 0x55d0c8a1e2c0] Compressed:       mjpeg :          Motion-JPEG : 1920x1080 1280x720 640x480
// The description may contain colons ("YUYV 4:2:2") and sizes may be ranges ("{32-2592, 2}x{32-1944, 2}").
const FORMAT_LINE =
  /\b(Raw|Compressed)\s*:\s*(\S+)\s*:\s*(.*?)\s*:(?:\s*Emulated\s*:)?((?:\s+(?:\d+x\d+|\{[^}]*\}x\{[^}]*\}))*)\s*$/;

/** Parses the output of `ffmpeg -f v4l2 -list_formats all -i <device>`. */
export function parseV4l2Formats(output: string): VideoDeviceFormat[] {
  const formats: VideoDeviceFormat[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = FORMAT_LINE.exec(line);
    // formats ffmpeg has no name for cannot be requested with -input_format
    if (!m || m[2] === "Unsupported") continue;
    const resolutions = m[4].match(/\b\d+x\d+\b/g) ?? [];
    const existing = formats.find((f) => f.name === m[2]);
    if (existing) {
      // e.g. MJPG and JPEG, which ffmpeg both reads as mjpeg
      existing.resolutions = sortResolutions([...existing.resolutions, ...resolutions]);
      continue;
    }
    formats.push({
      name: m[2],
      description: m[3],
      compressed: m[1] === "Compressed",
      resolutions: sortResolutions(resolutions),
    });
  }
  return formats;
}

function ffmpegFormats(node: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      // Only queries the device, so it is safe while a camera is streaming from it. ffmpeg exits
      // with an error after listing ("Immediate exit requested"); the listing is on stderr.
      execFile(
        "ffmpeg",
        ["-hide_banner", "-nostdin", "-loglevel", "info", "-f", "v4l2", "-list_formats", "all", "-i", node],
        { timeout: 5000 },
        (_err, _stdout, stderr) => resolve(String(stderr)),
      );
    } catch {
      resolve("");
    }
  });
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function videoNumber(entry: string): number {
  return Number(entry.replace(/^\D+/, ""));
}

/** Maps device nodes to the udev links in `dir` that point at them, shortest link first. */
function linksByNode(dir: string): Map<string, string[]> {
  const links = new Map<string, string[]>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return links;
  }
  for (const entry of entries.sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    if (entry.startsWith(".") || /\s/.test(entry)) continue;
    const link = path.join(dir, entry);
    try {
      const node = path.resolve(dir, readlinkSync(link));
      links.set(node, [...(links.get(node) ?? []), link]);
    } catch {
      // not a link
    }
  }
  return links;
}

export interface DeviceDiscoveryOptions {
  /** Where the kernel lists video devices. */
  sysfsDir?: string;
  /** Where the device nodes and udev's v4l links are. */
  devDir?: string;
  /** Returns ffmpeg's format listing for a device node (see parseV4l2Formats). */
  listFormats?: (node: string) => Promise<string>;
  platform?: NodeJS.Platform;
}

/** The USB capture devices connected to the server, marking those that `cameras` already use. */
export async function listVideoDevices(
  cameras: CameraConfig[] = [],
  opts: DeviceDiscoveryOptions = {},
): Promise<VideoDevicesResponse> {
  const {
    sysfsDir = "/sys/class/video4linux",
    devDir = "/dev",
    listFormats = ffmpegFormats,
    platform = process.platform,
  } = opts;
  if (platform !== "linux") return { devices: [], supported: false };
  let entries: string[];
  try {
    entries = readdirSync(sysfsDir).filter((e) => /^video\d+$/.test(e));
  } catch {
    return { devices: [], supported: true }; // no video devices at all
  }
  entries.sort((a, b) => videoNumber(a) - videoNumber(b));
  const usb = entries.filter((entry) => {
    try {
      return /\/usb\d+\//.test(realpathSync(path.join(sysfsDir, entry, "device")));
    } catch {
      return false; // virtual devices have no parent device
    }
  });
  // A USB camera has at least two nodes, and only the ones ffmpeg can list formats for capture
  // video. The others (usually the odd-numbered ones) carry metadata.
  const probed = await Promise.all(
    usb.map(async (entry) => {
      const node = path.join(devDir, entry);
      const name = readText(path.join(sysfsDir, entry, "name")) || entry;
      return { node, name, formats: parseV4l2Formats(await listFormats(node)) };
    }),
  );
  const capture = probed.filter((d) => d.formats.length > 0);
  const byId = linksByNode(path.join(devDir, "v4l", "by-id"));
  const byPath = linksByNode(path.join(devDir, "v4l", "by-path"));
  const devices = capture.map<VideoDevice>((d) => {
    const idLinks = byId.get(d.node) ?? [];
    const pathLinks = byPath.get(d.node) ?? [];
    // Identical cameras without serial numbers share a by-id name, so tell them apart by USB port.
    const twin = capture.some((other) => other !== d && other.name === d.name);
    const paths = [...idLinks, ...pathLinks, d.node];
    return {
      name: d.name,
      node: d.node,
      source: (twin ? pathLinks[0] : (idLinks[0] ?? pathLinks[0])) ?? d.node,
      paths,
      formats: d.formats,
      usedBy: cameras
        .filter((c) => c.kind === "device" && paths.includes(c.source))
        .map((c) => ({ id: c.id, name: c.name })),
    };
  });
  return { devices, supported: true };
}
