// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { OpenCodeClient, type EventStreamOpener, type OpenCodeEvent } from "@ai4s/sdk";

/** An event stream someone else carries (the web client's tab stream): each
 *  open is recorded with its handlers, so the test drives it. */
function carried() {
  const opens: { directory: string | null; h: Parameters<EventStreamOpener>[1]; stop: ReturnType<typeof vi.fn> }[] = [];
  const opener: EventStreamOpener = (directory, h) => {
    const stop = vi.fn();
    opens.push({ directory, h, stop });
    return stop;
  };
  return { opener, opens };
}

describe("OpenCodeClient with a carried event stream", () => {
  it("is ready on open, reads events, and reopens after the stream ends", async () => {
    const { opener, opens } = carried();
    const client = new OpenCodeClient({ baseUrl: "http://gw", directory: "/work", eventStream: opener });
    const events: OpenCodeEvent[] = [];
    client.onEvent((e) => events.push(e));

    const ready = client.connect();
    expect(opens).toHaveLength(1);
    expect(opens[0].directory).toBe("/work");
    opens[0].h.onOpen();
    await ready;
    expect(client.getStatus()).toBe("ready");

    opens[0].h.onMessage(JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_1" } }));
    expect(events.some((e) => e.type === "session.idle")).toBe(true);

    // It ended after opening: closed, and opened again on its own.
    opens[0].h.onError();
    expect(opens[0].stop).toHaveBeenCalled();
    await vi.waitFor(() => expect(opens).toHaveLength(2));

    client.close();
    expect(opens[1].stop).toHaveBeenCalled();
  });

  it("fails the connect when the stream cannot open", async () => {
    const { opener, opens } = carried();
    const client = new OpenCodeClient({ baseUrl: "http://gw", eventStream: opener });
    const ready = client.connect();
    opens[0].h.onError();
    await expect(ready).rejects.toThrow(/Could not open/);
    expect(opens[0].stop).toHaveBeenCalled();
  });
});
