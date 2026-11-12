import { describe, expect, it } from "vitest";
import { forwardArgs, forwardPreview, parsePorts, pickLocal, splitPreviewArgs } from "../src/forward.js";

describe("preview by local forward", () => {
  it("takes the workspace from the directory when the first word is a port", () => {
    expect(splitPreviewArgs(["3000"], () => "app")).toEqual({ id: "app", ports: ["3000"] });
    expect(splitPreviewArgs(["api", "3000", "5173"], () => "app")).toEqual({
      id: "api",
      ports: ["3000", "5173"],
    });
    expect(splitPreviewArgs([], () => "app")).toEqual({ id: "app", ports: [] });
  });

  it("accepts dev-server ports only, and names the fix", () => {
    expect(parsePorts(["3000", "5173"])).toEqual([3000, 5173]);
    expect(() => parsePorts([])).toThrow(/needs a port.*fix:/);
    expect(() => parsePorts(["22"])).toThrow(/1024 to 65535/);
    expect(() => parsePorts(["3000; rm -rf /"])).toThrow(/not a port/);
  });

  it("uses the same port here, or the next free one", async () => {
    expect(await pickLocal(3000, new Set(), async () => true)).toBe(3000);
    expect(await pickLocal(3000, new Set(), async (p) => p >= 3002)).toBe(3002);
    expect(await pickLocal(3000, new Set([3000]), async () => true)).toBe(3001);
    await expect(pickLocal(3000, new Set(), async () => false)).rejects.toThrow(/no free port/);
  });

  it("binds the local end to 127.0.0.1 and runs no remote command", () => {
    expect(forwardArgs([{ remote: 3000, local: 3001 }])).toEqual([
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-L",
      "127.0.0.1:3001:localhost:3000",
    ]);
  });

  it("prints where each port is, opens the first when it is up, and treats Ctrl-C as a normal end", async () => {
    const lines: string[] = [];
    const opened: string[] = [];
    let args: string[] = [];
    let end: (code: number) => void = () => {};
    const run = forwardPreview({
      id: "app",
      ports: ["3000", "5173"],
      open: true,
      ssh: (_id, extra) => {
        args = extra;
        return new Promise((resolve) => {
          end = resolve;
        });
      },
      opener: async (url) => {
        opened.push(url);
        end(130);
        return true;
      },
      err: (s) => lines.push(s),
      free: async (p) => p !== 3000,
      wait: async () => true,
    });
    expect(await run).toBe(0);
    expect(lines[0]).toBe("http://localhost:3001  →  app port 3000 (port 3000 is in use here)");
    expect(lines[1]).toBe("http://localhost:5173  →  app port 5173");
    expect(args).toContain("127.0.0.1:3001:localhost:3000");
    expect(args).toContain("127.0.0.1:5173:localhost:5173");
    expect(opened).toEqual(["http://localhost:3001"]);
  });

  it("returns the ssh failure, and opens nothing when the forward never comes up", async () => {
    const opened: string[] = [];
    const code = await forwardPreview({
      id: "app",
      ports: ["3000"],
      open: true,
      ssh: async () => 1,
      opener: async (u) => {
        opened.push(u);
        return true;
      },
      err: () => {},
      free: async () => true,
      wait: () => new Promise(() => {}),
    });
    expect(code).toBe(1);
    expect(opened).toEqual([]);
  });
});
