// Where a layout goes besides this browser's own storage.
//
// - The desktop window and a web client signed in with the TOKEN share one set
//   of Screens, live: the window publishes its layout, a token client mirrors
//   it (polling for a newer revision) and writes its own changes back, and the
//   gateway tells the window about those at once. Last write wins.
// - A token client can switch to Screens of its OWN instead, kept in this
//   browser; switching back and forth keeps both.
// - A web client signed in with an ACCOUNT keeps its own Screens on the
//   desktop — browser storage is per address, and an account is the same
//   person at 127.0.0.1, at the LAN IP, and at whatever IP the router hands
//   out next. It never sees the window's.
import { isTauri, publishDesktopLayout } from "./tauri";
import {
  gatewayOrigin,
  gatewayToken,
  isGatewayWeb,
  layoutSource,
  setLayoutSource,
  signedInAccount,
  type LayoutSource,
} from "./webMode";

type Mode = "desktop" | "mirror" | "own" | "account" | null;

/** A token client's own Screens, apart from the mirrored ones it shows while
 *  following the window. */
const OWN_KEY = "ai4s.layout.own";

/** How often a token client asks whether the shared Screens changed. */
const POLL_MS = 1000;

let mode: Mode = isTauri ? "desktop" : null;
let timer: ReturnType<typeof setTimeout> | undefined;
let poller: ReturnType<typeof setInterval> | undefined;
/** The shared layout's revision this client last saw or wrote. */
let rev = 0;
/** The shared part (`sharedPart`) of the layout last sent or taken from
 *  elsewhere. A change that leaves it as it was — adopting what arrived, or
 *  only switching Screen or focus — is this view's own and is not sent: it
 *  would tell the others nothing, and could overwrite a change of theirs
 *  that has not reached this view yet. */
let lastShared: string | null = null;

const auth = (): Record<string, string> => {
  const token = gatewayToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/** What views share of a layout: everything but where one of them is looking
 *  (see `keepOwnView`). Anything that is not a layout compares as itself. */
function sharedPart(json: string): string {
  try {
    const { groups } = JSON.parse(json) as { groups?: Array<Record<string, unknown>> };
    if (!Array.isArray(groups)) return json;
    return JSON.stringify(groups.map((g) => ({ ...g, focusedLeafId: undefined, zoomedLeafId: undefined })));
  } catch {
    return json;
  }
}

/** Every local layout change (from `persist`). */
export function layoutChanged(json: string): void {
  if (!mode) return;
  // Its own Screens keep this view's position too, so every change is saved.
  if (mode === "own") {
    clearTimeout(timer);
    return void push(json);
  }
  const shared = sharedPart(json);
  if (shared === lastShared) return;
  clearTimeout(timer);
  lastShared = shared;
  // The window and a mirror share one layout: keep the other side close behind.
  timer = setTimeout(() => void push(json), mode === "account" ? 800 : 300);
}

async function push(json: string): Promise<void> {
  try {
    if (mode === "own") {
      window.localStorage.setItem(OWN_KEY, json);
    } else if (mode === "desktop") {
      await publishDesktopLayout(json);
    } else if (mode === "mirror") {
      const res = await fetch(`${gatewayOrigin()}/v1/layout/desktop`, {
        method: "PUT",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: json,
      });
      if (res.ok) rev = ((await res.json()) as { rev: number }).rev;
    } else if (mode === "account") {
      await fetch(`${gatewayOrigin()}/v1/me/layout`, {
        method: "PUT",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: json,
      });
    }
  } catch {
    // The next change writes again; a missed one costs one change.
  }
}

/** Show a layout that came from elsewhere. False when it is not one.
 *  `keepView`: stay on this view's own Screen and panes (see `keepOwnView`) —
 *  everywhere but a view's first look, which starts where the layout is. */
async function apply(value: unknown, keepView: boolean): Promise<boolean> {
  const { keepOwnView, parseLayout, useLayoutStore } = await import("./layout");
  const arrived = parseLayout(value);
  if (!arrived) return false;
  const { groups, activeGroupId } = useLayoutStore.getState();
  const layout = keepView ? keepOwnView(arrived, { groups, activeGroupId }) : arrived;
  // What arrived supersedes a local change not yet sent.
  clearTimeout(timer);
  lastShared = sharedPart(JSON.stringify({ groups: layout.groups, activeGroupId: layout.activeGroupId }));
  useLayoutStore.getState().adoptLayout(layout);
  // A view's first look replaced where it was — including the conversation its
  // address names (a link opened in a new tab). Show that one, the way the
  // sidebar does: on its Screen if it has one, else in a preview Screen, never
  // by swapping a pane another view may be looking at.
  const linked = !keepView && window.location.pathname.match(/^\/live\/([^/]+)$/)?.[1];
  if (linked) useLayoutStore.getState().openSessionEphemeral(decodeURIComponent(linked));
  return true;
}

async function current(): Promise<string> {
  const { useLayoutStore } = await import("./layout");
  const { groups, activeGroupId } = useLayoutStore.getState();
  return JSON.stringify({ groups, activeGroupId });
}

// The window hears about a token client's change from the gateway directly.
if (isTauri) {
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<string>("gateway:desktop-layout", (e) => void apply(JSON.parse(e.payload), true)))
    .catch(() => {});
}

/** A token client: the window's Screens, or its own — whichever this browser
 *  last chose. */
export async function mirrorDesktopLayout(): Promise<void> {
  if (!isGatewayWeb || signedInAccount() || mode === "mirror" || mode === "own") return;
  if (layoutSource() === "own") return showOwnLayout();
  await followDesktop();
}

/** Switch a token client between the window's Screens and its own. */
export async function switchLayoutSource(source: LayoutSource): Promise<void> {
  if (!isGatewayWeb || signedInAccount() || source === layoutSource()) return;
  setLayoutSource(source);
  clearTimeout(timer);
  clearInterval(poller);
  mode = null;
  if (source === "own") await showOwnLayout();
  else await followDesktop();
}

/** Show this browser's own Screens; the first time, a copy of the window's
 *  current ones (under new ids, terminals as new shells of their own). */
async function showOwnLayout(): Promise<void> {
  const { cloneLayout, parseLayout, useLayoutStore } = await import("./layout");
  let saved: unknown = null;
  try {
    saved = JSON.parse(window.localStorage.getItem(OWN_KEY) ?? "null");
  } catch {
    saved = null;
  }
  mode = "own";
  if (await apply(saved, false)) return;
  const { groups, activeGroupId } = useLayoutStore.getState();
  const copy = cloneLayout(parseLayout({ groups, activeGroupId }) ?? { groups, activeGroupId });
  await apply(copy, false);
  void push(await current());
}

/** Take the window's Screens, then keep following them. */
async function followDesktop(): Promise<void> {
  let first: { rev: number; layout: unknown } | null = null;
  try {
    const res = await fetch(`${gatewayOrigin()}/v1/layout/desktop`, { headers: auth() });
    if (!res.ok) return; // stay on this browser's own layout rather than guess
    first = (await res.json()) as { rev: number; layout: unknown };
  } catch {
    return;
  }
  mode = "mirror";
  rev = first.rev;
  // A window that has published nothing yet gets this browser's Screens.
  if (!(await apply(first.layout, false))) void push(await current());
  poller = setInterval(() => void poll(), POLL_MS);
}

async function poll(): Promise<void> {
  if (typeof document !== "undefined" && document.hidden) return;
  try {
    const res = await fetch(`${gatewayOrigin()}/v1/layout/desktop?since=${rev}`, { headers: auth() });
    if (res.status !== 200) return; // 204: nothing newer
    const next = (await res.json()) as { rev: number; layout: unknown };
    // Switched to its own Screens while this was in flight: not ours to show.
    if (mode !== "mirror") return;
    rev = next.rev;
    await apply(next.layout, true);
  } catch {
    // The next poll is a second away.
  }
}

/** An account: show its Screens, or — the first time — make this browser's
 *  the account's. Until they are read nothing is written: the fresh page's
 *  default layout would overwrite the one being fetched. */
export async function adoptAccountLayout(): Promise<void> {
  if (!isGatewayWeb || mode === "account") return;
  let saved: unknown = null;
  try {
    const res = await fetch(`${gatewayOrigin()}/v1/me/layout`, { headers: auth() });
    if (!res.ok) return; // not readable now; stay local rather than overwrite
    saved = await res.json();
  } catch {
    return;
  }
  mode = "account";
  if (!(saved && (await apply(saved, false)))) void push(await current());
}

/** For the tests. */
export function resetLayoutSync(): void {
  clearTimeout(timer);
  clearInterval(poller);
  mode = isTauri ? "desktop" : null;
  rev = 0;
  lastShared = null;
}
