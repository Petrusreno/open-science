// How a terminal pane reaches its shell.
//
// The desktop app talks to its own PTYs over Tauri commands and events. A web
// client (the remote-access gateway) reaches the SAME PTY layer on the desktop
// through `/v1/terminals/...`, which the user has to switch on in Settings. The
// pane does not care which: it opens, writes, resizes, closes and reads output.
import { isTauri } from "./tauri";
import { gatewayOrigin, gatewayPost, gatewayToken, isGatewayWeb, layoutSource, signedInAccount } from "./webMode";

export interface TerminalOutput {
  onData: (chunk: string) => void;
  /** The shell exited. */
  onExit: () => void;
  /** The stream was re-established and will replay the shell's recent output:
   *  clear the screen first, or that output is drawn twice. Web only. */
  onReset: () => void;
}

export interface TerminalTransport {
  /** True when a new shell was started; false when it was already running —
   *  then nothing may be typed into it on the pane's behalf. */
  open(id: string, cwd: string | undefined, cols: number, rows: number): Promise<boolean>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  close(id: string): Promise<void>;
  /** Start reading output; the returned function stops. */
  subscribe(id: string, output: TerminalOutput): Promise<() => void>;
}

const desktop: TerminalTransport = {
  async open(id, cwd, cols, rows) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("terminal_open", { id, cwd, cols, rows });
  },
  async write(id, data) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("terminal_write", { id, data });
  },
  async resize(id, cols, rows) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("terminal_resize", { id, cols, rows });
  },
  async close(id) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("terminal_close", { id });
  },
  async subscribe(id, { onData, onExit }) {
    const [{ invoke }, { listen }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
    ]);
    const [dataEvent, exitEvent] = await invoke<[string, string]>("terminal_event_names", { id });
    const unlistenData = await listen<string>(dataEvent, (event) => onData(event.payload));
    const unlistenExit = await listen(exitEvent, () => onExit());
    return () => {
      unlistenData();
      unlistenExit();
    };
  },
};

/** This browser's own name for shells that are its own. Pane ids are `p1`,
 *  `p2`… in every client, so a bare pane id would collide with a desktop
 *  terminal (which the gateway refuses an account) or with another browser's,
 *  which would then type into this one's shell. One random id per browser,
 *  kept so a reload finds its shells again. A token client following the
 *  window's Screens needs none: there the same pane id IS the same shell, on
 *  purpose. */
function clientId(): string {
  const KEY = "os_terminal_client";
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved && /^[a-z0-9]{12}$/.test(saved)) return saved;
    const fresh = randomId();
    window.localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return (sessionClient ??= randomId());
  }
}
let sessionClient: string | undefined;

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

/** Following the desktop window's Screens: its shells are this page's. */
const sharesDesktopShells = () => !signedInAccount() && layoutSource() === "desktop";

/** Each pane's shell, as named when it was opened: switching between the
 *  window's Screens and one's own must not re-route a shell already open, or
 *  leave one behind under a name nobody uses any more. */
const opened = new Map<string, { wire: string; shared: boolean }>();

function shellOf(id: string): { wire: string; shared: boolean } {
  const known = opened.get(id);
  if (known) return known;
  const shared = sharesDesktopShells();
  return { wire: shared ? id : `w${clientId()}-${id}`, shared };
}

const path = (id: string, rest = "") => `/v1/terminals/${encodeURIComponent(shellOf(id).wire)}${rest}`;
const authHeader = (): Record<string, string> => {
  const token = gatewayToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/** How long to wait before reading a dropped output stream again. */
const RECONNECT_MS = 1000;

const web: TerminalTransport = {
  async open(id, cwd, cols, rows) {
    const shell = shellOf(id);
    opened.set(id, shell);
    const res = await gatewayPost<{ created?: boolean }>(path(id), { cwd: cwd ?? null, cols, rows });
    return res?.created === true;
  },
  async write(id, data) {
    await gatewayPost(path(id, "/input"), { data });
  },
  async resize(id, cols, rows) {
    await gatewayPost(path(id, "/resize"), { cols, rows });
  },
  async close(id) {
    const shell = shellOf(id);
    opened.delete(id);
    // A shell shared with the desktop window is the window's: it ends it when
    // the pane leaves the shared layout. Ending it from here as well could kill
    // one the window had just opened, from a moment the two layouts disagreed.
    if (shell.shared) return;
    const url = `${gatewayOrigin()}/v1/terminals/${encodeURIComponent(shell.wire)}`;
    await fetch(url, { method: "DELETE", headers: authHeader() });
  },
  async subscribe(id, output) {
    // fetch rather than EventSource: EventSource cannot send a header, and the
    // token must not ride in a URL.
    const abort = new AbortController();
    void (async () => {
      for (let attempt = 0; !abort.signal.aborted; attempt++) {
        try {
          const res = await fetch(`${gatewayOrigin()}${path(id, "/output")}`, {
            headers: authHeader(),
            signal: abort.signal,
          });
          // Gone (closed elsewhere, or access withdrawn): nothing to come back to.
          if (!res.ok || !res.body) return output.onExit();
          if (attempt > 0) output.onReset();
          if (await readEvents(res.body, output)) return;
        } catch {
          if (abort.signal.aborted) return;
        }
        await new Promise((r) => setTimeout(r, RECONNECT_MS));
      }
    })();
    return () => abort.abort();
  },
};

/** Read server-sent events until the stream ends. True when the shell exited
 *  (`event: exit`), false when only the connection dropped. */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  output: Pick<TerminalOutput, "onData" | "onExit">,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return false;
    buffered += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffered.indexOf("\n\n")) >= 0) {
      const frame = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (event === "exit") {
        output.onExit();
        return true;
      }
      if (data) output.onData(JSON.parse(data) as string);
    }
  }
}

export const terminalTransport: TerminalTransport = isGatewayWeb ? web : desktop;

/** Whether this client has terminals at all: the desktop app always, a web
 *  client only once the desktop allows it (`webTerminal`, from /v1/whoami). */
export function terminalsAvailable(webTerminal: boolean): boolean {
  return isTauri || (isGatewayWeb && webTerminal);
}
