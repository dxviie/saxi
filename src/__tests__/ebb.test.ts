import { beforeEach, describe, expect, it, vi } from "vitest";
import { EBB, type EBBPort } from "../ebb.js";
import { SerialPortSerialPort } from "../serialport-serialport.js";
import { createMockSerialPort, mockSerialPortInstance } from "./mocks/serialport.js";

vi.mock("../serialport-serialport", () => ({
  SerialPortSerialPort: vi.fn(function SerialPortSerialPort() {
    return createMockSerialPort();
  }),
}));

describe("EBB", () => {
  beforeEach(() => {
    mockSerialPortInstance.clearCommands();
  });

  it("firmware version", async () => {
    const port = new SerialPortSerialPort("/dev/ebb");
    await port.open({ baudRate: 9600 });
    const ebb = await EBB.create(port);

    const version = ebb.firmwareVersion;
    expect(version).toEqual([2, 5, 3]);
    expect(mockSerialPortInstance.commands).toContain("V");
  });

  it("gives up on a board that does not answer", async () => {
    const written: string[] = [];
    const silent: EBBPort = {
      readable: new ReadableStream<Uint8Array>(), // never says anything
      writable: new WritableStream<Uint8Array>({
        write: (chunk) => void written.push(new TextDecoder().decode(chunk)),
      }),
      close: async () => {},
    };
    await expect(EBB.create(silent, "v3", 50)).rejects.toThrow("no answer to the firmware version query (V)");
    expect(written).toEqual(["V\r"]);
  });

  it("enable motors", async () => {
    const port = new SerialPortSerialPort("/dev/ebb");
    await port.open({ baudRate: 9600 });
    const ebb = await EBB.create(port);

    await ebb.enableMotors(2);
    expect(mockSerialPortInstance.commands).toContain("EM,2,2");
    expect(mockSerialPortInstance.commands).toContain("V"); // Version check for supportsSR()
  });
});
