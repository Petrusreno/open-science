import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebTokenGate } from "./WebTokenGate";

const stored = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("@/lib/webMode", () => ({
  gatewayOrigin: () => "http://gw",
  setGatewayToken: (t: string) => {
    stored.token = t;
  },
}));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  stored.token = null;
});
afterEach(() => vi.unstubAllGlobals());

async function signIn(name: string, password: string) {
  await userEvent.type(screen.getByRole("textbox", { name: "Name" }), name);
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("WebTokenGate", () => {
  it("signs in with an account and uses the session where the token would go", async () => {
    const fetchMock = vi.fn(async () => json(200, { token: "s".repeat(64), user: "dana" }));
    vi.stubGlobal("fetch", fetchMock);
    const onConnect = vi.fn();
    render(<WebTokenGate onConnect={onConnect} />);
    await signIn("dana", "a long password");
    await waitFor(() => expect(onConnect).toHaveBeenCalled());
    expect(stored.token).toBe("s".repeat(64));
    expect(fetchMock).toHaveBeenCalledWith("http://gw/v1/login", expect.objectContaining({ method: "POST" }));
  });

  it("says a wrong password plainly, and a lockout with how long", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(401, { error: "invalid" }))
        .mockResolvedValueOnce(json(429, { error: "locked", retryAfter: 90 })),
    );
    render(<WebTokenGate onConnect={() => {}} />);
    await signIn("dana", "nope nope");
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong name or password.");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in 2 min.");
    expect(stored.token).toBeNull();
  });

  it("still takes an access token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { mode: "full" })));
    const onConnect = vi.fn();
    render(<WebTokenGate onConnect={onConnect} />);
    await userEvent.click(screen.getByRole("button", { name: "Use an access token instead" }));
    await userEvent.type(screen.getByLabelText("Access token"), "tok");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onConnect).toHaveBeenCalled());
    expect(stored.token).toBe("tok");
  });
});
