import { describe, expect, it } from "vitest";
import {
  bridge,
  isPublicKey,
  parseResize,
  type SocketLike,
  type StdioProcess,
  shellParams,
} from "../src/orb/terminal";

class FakeSocket implements SocketLike {
  sent: unknown[] = [];
  closed?: { code?: number; reason?: string };
  private handlers: Record<string, ((ev: { data: unknown }) => void)[]> = {};
  send(data: ArrayBuffer | ArrayBufferView | string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed ??= { code, reason };
  }
  addEventListener(type: string, fn: (ev: { data: unknown }) => void) {
    const list = this.handlers[type] ?? [];
    list.push(fn);
    this.handlers[type] = list;
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.handlers[type] ?? []) fn({ data });
  }
}

function fakeProc() {
  const written: Uint8Array[] = [];
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  const proc = {
    resizes: [] as [number, number][],
    killed: 0,
    stdinClosed: false,
    stdin: new WritableStream<Uint8Array>({
      write: (c) => {
        written.push(c);
      },
      close: () => {
        proc.stdinClosed = true;
      },
    }),
    stdout: new ReadableStream<Uint8Array>({ start: (c) => (out = c) }),
    exitCode: new Promise<number>((r) => (exit = r)),
    kill() {
      proc.killed++;
      try {
        out.close();
      } catch {}
      exit(143);
    },
    resize(cols: number, rows: number) {
      proc.resizes.push([cols, rows]);
    },
  };
  return { proc: proc as typeof proc & StdioProcess, written, out: () => out, exit: (c: number) => exit(c) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const text = (chunks: Uint8Array[]) => new TextDecoder().decode(Buffer.concat(chunks));

describe("bridge", () => {
  it("shell: binary frames reach stdin in order, text frames resize, output reaches the socket", async () => {
    const ws = new FakeSocket();
    const p = fakeProc();
    let activity = 0;
    const done = bridge(ws, p.proc, { control: true, onActivity: () => activity++ });
    ws.emit("message", new TextEncoder().encode("ls").buffer);
    ws.emit("message", JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    ws.emit("message", new Blob([" -la\r"])); // Workers deliver binary frames as Blob
    p.out().enqueue(new TextEncoder().encode("total 0\r\n"));
    await tick();
    await tick();
    expect(text(p.written)).toBe("ls -la\r");
    expect(p.proc.resizes).toEqual([[120, 40]]);
    expect(text(ws.sent as Uint8Array[])).toBe("total 0\r\n");
    expect(activity).toBeGreaterThanOrEqual(3);
    // tmux client exits (the user detached): the socket closes with the exit code.
    p.out().close();
    p.exit(0);
    await done;
    expect(ws.closed).toEqual({ code: 1000, reason: "exit 0" });
  });

  it("ssh: text frames are bytes, not control", async () => {
    const ws = new FakeSocket();
    const p = fakeProc();
    const done = bridge(ws, p.proc, { control: false, onActivity: () => {} });
    ws.emit("message", '{"type":"resize","cols":1,"rows":1}');
    await tick();
    expect(text(p.written)).toBe('{"type":"resize","cols":1,"rows":1}');
    expect(p.proc.resizes).toEqual([]);
    ws.emit("close");
    await done;
  });

  it("a client that goes away kills the attached process and closes its stdin", async () => {
    const ws = new FakeSocket();
    const p = fakeProc();
    const done = bridge(ws, p.proc, { control: true, onActivity: () => {} });
    ws.emit("close");
    await done;
    expect(p.proc.killed).toBe(1);
    expect(p.proc.stdinClosed).toBe(true);
  });
});

describe("terminal parameters", () => {
  it("parseResize takes only whole sizes from 1 to 1000", () => {
    expect(parseResize('{"type":"resize","cols":80,"rows":24}')).toEqual({ cols: 80, rows: 24 });
    for (const bad of [
      '{"type":"resize","cols":0,"rows":24}',
      '{"type":"resize","cols":80.5,"rows":24}',
      '{"type":"x","cols":80,"rows":24}',
      "nope",
    ])
      expect(parseResize(bad)).toBeUndefined();
  });

  it("shellParams defaults to 80x24 session main and refuses odd session names", () => {
    expect(shellParams(new URL("https://w/shell"))).toEqual({ cols: 80, rows: 24, session: "main" });
    expect(shellParams(new URL("https://w/shell?cols=200&rows=50&session=agent-2"))).toEqual({
      cols: 200,
      rows: 50,
      session: "agent-2",
    });
    expect(shellParams(new URL("https://w/shell?session=a;rm"))).toHaveProperty("error");
    expect(shellParams(new URL("https://w/shell?cols=0"))).toHaveProperty("error");
  });

  it("isPublicKey takes one OpenSSH key line and nothing that could add a second line or options", () => {
    expect(
      isPublicKey(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop",
      ),
    ).toBe(true);
    expect(
      isPublicKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"),
    ).toBe(true);
    expect(isPublicKey('command="sh" ssh-ed25519 AAAAC3Nza')).toBe(false);
    expect(isPublicKey("ssh-ed25519 AAAA\nssh-ed25519 BBBB")).toBe(false);
    expect(isPublicKey(null)).toBe(false);
  });
});
