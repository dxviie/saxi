import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { LINUX_DEVICE_PATH, listVideoDevices, parseV4l2Formats } from "../camera-devices.js";
import { type CameraConfig, defaultCameraConfig, sortResolutions } from "../camera-types.js";

// `ffmpeg -f v4l2 -list_formats all -i /dev/video0` for a typical UVC webcam, as libavdevice prints it
const WEBCAM = `[video4linux2,v4l2 @ 0x55d0c8a1e2c0] Raw       :     yuyv422 :           YUYV 4:2:2 : 640x480 160x120 320x240 1280x720 1920x1080
[video4linux2,v4l2 @ 0x55d0c8a1e2c0] Compressed:        h264 :                H.264 : 640x480 1920x1080
[video4linux2,v4l2 @ 0x55d0c8a1e2c0] Compressed:       mjpeg :          Motion-JPEG : 640x480 160x120 320x240 1280x720 1920x1080
[in#0 @ 0x55d0c8a1e000] Error opening input: Immediate exit requested
Error opening input file /dev/video0.
`;

// the same for the camera's metadata node
const METADATA = `[video4linux2,v4l2 @ 0x5581c3e9d2c0] ioctl(VIDIOC_G_INPUT): Inappropriate ioctl for device
/dev/video1: Inappropriate ioctl for device
`;

describe("format listing", () => {
  test("parses raw and compressed formats with their sizes, widest first", () => {
    expect(parseV4l2Formats(WEBCAM)).toEqual([
      {
        name: "yuyv422",
        description: "YUYV 4:2:2",
        compressed: false,
        resolutions: ["1920x1080", "1280x720", "640x480", "320x240", "160x120"],
      },
      { name: "h264", description: "H.264", compressed: true, resolutions: ["1920x1080", "640x480"] },
      {
        name: "mjpeg",
        description: "Motion-JPEG",
        compressed: true,
        resolutions: ["1920x1080", "1280x720", "640x480", "320x240", "160x120"],
      },
    ]);
  });

  test("finds nothing on a node that cannot capture video", () => {
    expect(parseV4l2Formats(METADATA)).toEqual([]);
    expect(parseV4l2Formats("")).toEqual([]);
  });

  test("handles size ranges, emulated, unsupported and duplicate formats", () => {
    const output = [
      "[video4linux2,v4l2 @ 0x1] Raw       :     yuv420p :     Planar YUV 4:2:0 : {32-2592, 2}x{32-1944, 2}",
      "[video4linux2,v4l2 @ 0x1] Raw       :       bgr24 :                 BGR3 : Emulated : 640x480 320x240",
      "[video4linux2,v4l2 @ 0x1] Raw       : Unsupported :         16-bit Depth : 640x480",
      "[video4linux2,v4l2 @ 0x1] Compressed:       mjpeg :          Motion-JPEG : 1280x720",
      "[video4linux2,v4l2 @ 0x1] Compressed:       mjpeg :            JFIF JPEG : 640x480",
    ].join("\n");
    expect(parseV4l2Formats(output)).toEqual([
      { name: "yuv420p", description: "Planar YUV 4:2:0", compressed: false, resolutions: [] },
      { name: "bgr24", description: "BGR3", compressed: false, resolutions: ["640x480", "320x240"] },
      { name: "mjpeg", description: "Motion-JPEG", compressed: true, resolutions: ["1280x720", "640x480"] },
    ]);
  });

  test("sorts resolutions widest first without duplicates", () => {
    expect(sortResolutions(["640x480", "960x720", "1920x1080", "640x480", "1024x576", "640x360"])).toEqual([
      "1920x1080",
      "1024x576",
      "960x720",
      "640x480",
      "640x360",
    ]);
  });
});

describe("device paths", () => {
  test("accepts device nodes and udev's stable links only", () => {
    for (const ok of [
      "/dev/video0",
      "/dev/video12",
      "/dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920_8A4F3C6F-video-index0",
      "/dev/v4l/by-path/pci-0000:00:14.0-usb-0:2:1.0-video-index0",
      "/dev/v4l/by-path/platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
    ]) {
      expect(LINUX_DEVICE_PATH.test(ok), ok).toBe(true);
    }
    for (const bad of [
      "/etc/passwd",
      "/dev/video",
      "/dev/sda",
      "/dev/v4l/by-id/",
      "/dev/v4l/by-id/..",
      "/dev/v4l/by-id/../../../etc/passwd",
      "/dev/v4l/by-id/usb-cam/../../../etc/passwd",
      "/dev/v4l/by-uuid/abc",
      "-f /dev/video0",
    ]) {
      expect(LINUX_DEVICE_PATH.test(bad), bad).toBe(false);
    }
  });
});

/** Builds a fake /sys/class/video4linux and /dev with udev's v4l links in a temporary directory. */
function fakeSystem() {
  const root = mkdtempSync(path.join(tmpdir(), "saxi-v4l-"));
  const sysfsDir = path.join(root, "sys", "class", "video4linux");
  const devDir = path.join(root, "dev");
  mkdirSync(devDir, { recursive: true });
  return {
    sysfsDir,
    devDir,
    /** A video node; `parent` is the device's path below /sys/devices, null for a virtual device. */
    node(n: number, name: string, parent: string | null) {
      const dir = path.join(sysfsDir, `video${n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "name"), `${name}\n`);
      if (parent) {
        const target = path.join(root, "sys", "devices", parent);
        mkdirSync(target, { recursive: true });
        symlinkSync(target, path.join(dir, "device"));
      }
      writeFileSync(path.join(devDir, `video${n}`), "");
    },
    link(kind: "by-id" | "by-path", name: string, n: number) {
      const dir = path.join(devDir, "v4l", kind);
      mkdirSync(dir, { recursive: true });
      symlinkSync(`../../video${n}`, path.join(dir, name));
    },
  };
}

function camera(id: string, patch: Partial<CameraConfig>): CameraConfig {
  return { ...defaultCameraConfig, id, name: id, ...patch };
}

// symlinks need extra privileges on Windows, and device discovery is Linux only anyway
describe.skipIf(process.platform === "win32")("device discovery", () => {
  const usb = (port: string) => `pci0000:00/0000:00:14.0/usb1/1-${port}/1-${port}:1.0`;

  test("lists USB capture nodes with stable paths and marks the ones in use", async () => {
    const sys = fakeSystem();
    // two identical webcams without a serial number, then a different one
    sys.node(0, "USB Camera", usb("2"));
    sys.node(1, "USB Camera", usb("2"));
    sys.node(2, "USB Camera", usb("3"));
    sys.node(3, "USB Camera", usb("3"));
    sys.node(4, "Logitech BRIO", usb("4"));
    sys.node(5, "Logitech BRIO", usb("4"));
    // a Raspberry Pi CSI receiver and a loopback device, neither of which should be probed
    sys.node(6, "unicam-image", "platform/soc/fe801000.csi");
    sys.node(7, "Dummy video device", null);
    // identical cameras share a by-id name, so it points at whichever was plugged in last
    sys.link("by-id", "usb-Generic_USB_Camera-video-index0", 2);
    sys.link("by-id", "usb-Generic_USB_Camera-video-index1", 3);
    sys.link("by-id", "usb-046d_Logitech_BRIO_1234ABCD-video-index0", 4);
    sys.link("by-id", "usb-046d_Logitech_BRIO_1234ABCD-video-index1", 5);
    sys.link("by-path", "pci-0000:00:14.0-usb-0:2:1.0-video-index0", 0);
    sys.link("by-path", "pci-0000:00:14.0-usbv2-0:2:1.0-video-index0", 0);
    sys.link("by-path", "pci-0000:00:14.0-usb-0:2:1.0-video-index1", 1);
    sys.link("by-path", "pci-0000:00:14.0-usb-0:3:1.0-video-index0", 2);
    sys.link("by-path", "pci-0000:00:14.0-usb-0:4:1.0-video-index0", 4);
    sys.link("by-path", "platform-fe801000.csi-video-index0", 6);

    const dev = (p: string) => path.join(sys.devDir, p);
    const probed: string[] = [];
    const cameras = [
      camera("top", { name: "Top", source: dev("video4") }),
      camera("side", { name: "Side", source: dev("v4l/by-path/pci-0000:00:14.0-usb-0:2:1.0-video-index0") }),
      camera("phone", { kind: "url", source: dev("video2") }), // not a device camera
    ];
    const result = await listVideoDevices(cameras, {
      sysfsDir: sys.sysfsDir,
      devDir: sys.devDir,
      platform: "linux",
      listFormats: async (node) => {
        probed.push(path.basename(node));
        return Number(node.slice(-1)) % 2 === 0 ? WEBCAM : METADATA;
      },
    });

    expect(probed.sort()).toEqual(["video0", "video1", "video2", "video3", "video4", "video5"]);
    expect(result.supported).toBe(true);
    expect(result.devices.map(({ formats, ...d }) => d)).toEqual([
      {
        name: "USB Camera",
        node: dev("video0"),
        source: dev("v4l/by-path/pci-0000:00:14.0-usb-0:2:1.0-video-index0"),
        paths: [
          dev("v4l/by-path/pci-0000:00:14.0-usb-0:2:1.0-video-index0"),
          dev("v4l/by-path/pci-0000:00:14.0-usbv2-0:2:1.0-video-index0"),
          dev("video0"),
        ],
        usedBy: [{ id: "side", name: "Side" }],
      },
      {
        name: "USB Camera",
        node: dev("video2"),
        // by port rather than by the by-id name it shares with its twin
        source: dev("v4l/by-path/pci-0000:00:14.0-usb-0:3:1.0-video-index0"),
        paths: [
          dev("v4l/by-id/usb-Generic_USB_Camera-video-index0"),
          dev("v4l/by-path/pci-0000:00:14.0-usb-0:3:1.0-video-index0"),
          dev("video2"),
        ],
        usedBy: [],
      },
      {
        name: "Logitech BRIO",
        node: dev("video4"),
        source: dev("v4l/by-id/usb-046d_Logitech_BRIO_1234ABCD-video-index0"),
        paths: [
          dev("v4l/by-id/usb-046d_Logitech_BRIO_1234ABCD-video-index0"),
          dev("v4l/by-path/pci-0000:00:14.0-usb-0:4:1.0-video-index0"),
          dev("video4"),
        ],
        usedBy: [{ id: "top", name: "Top" }],
      },
    ]);
    expect(result.devices[0].formats.map((f) => f.name)).toEqual(["yuyv422", "h264", "mjpeg"]);
  });

  test("falls back to the device node when there are no udev links", async () => {
    const sys = fakeSystem();
    sys.node(0, "USB Camera", usb("2"));
    const result = await listVideoDevices([], {
      sysfsDir: sys.sysfsDir,
      devDir: sys.devDir,
      platform: "linux",
      listFormats: async () => WEBCAM,
    });
    expect(result.devices.map((d) => [d.source, d.paths])).toEqual([
      [path.join(sys.devDir, "video0"), [path.join(sys.devDir, "video0")]],
    ]);
  });

  test("reports no devices when there are none, and nothing but Linux as unsupported", async () => {
    const listFormats = async () => {
      throw new Error("should not probe");
    };
    const missing = path.join(tmpdir(), "saxi-no-such-dir", "video4linux");
    expect(await listVideoDevices([], { sysfsDir: missing, platform: "linux", listFormats })).toEqual({
      devices: [],
      supported: true,
    });
    expect(await listVideoDevices([], { platform: "darwin", listFormats })).toEqual({
      devices: [],
      supported: false,
    });
  });
});
