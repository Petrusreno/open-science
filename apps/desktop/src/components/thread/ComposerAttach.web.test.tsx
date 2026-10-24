import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";
import { discardUpload, uploadToWorkspace } from "@/lib/artifactFile";
import { addBinaryToWorkspace } from "@/lib/tauri";

// The browser served by the gateway: no Tauri bridge, files go up over HTTP
// into the session's folder.
vi.mock("@/lib/webMode", async (orig) => ({
  ...(await orig<typeof import("@/lib/webMode")>()),
  isGatewayWeb: true,
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: false,
  addFilesToWorkspace: vi.fn(async () => []),
  addTextToWorkspace: vi.fn(async () => "pasted.txt"),
  addBinaryToWorkspace: vi.fn(async (filename: string) => filename),
  addPathsToWorkspace: vi.fn(async () => []),
  discardWorkspaceFile: vi.fn(async () => {}),
  logDebug: vi.fn(async () => {}),
}));

vi.mock("@/lib/artifactFile", () => ({
  previewUrl: vi.fn(async () => null),
  readArtifact: vi.fn(async () => null),
  absoluteArtifactPath: vi.fn(async () => null),
  // A file named "huge.bin" is refused, as the gateway would refuse it.
  uploadToWorkspace: vi.fn(async (name: string) => {
    if (name === "huge.bin") throw new Error("file is too large");
    return name;
  }),
  discardUpload: vi.fn(async () => {}),
}));

const DIR = "/ws/ses1";

describe("Composer attachments (web)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uploads a pasted screenshot into the session folder", async () => {
    render(<Composer onSend={vi.fn()} sessionDir={DIR} />);
    const input = screen.getByLabelText("Ask anything") as HTMLTextAreaElement;
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "",
        items: [{ kind: "file", type: "image/png", getAsFile: () => png }],
      },
    });
    await waitFor(() => expect(screen.getByText("pasted.png")).toBeTruthy());
    expect(uploadToWorkspace).toHaveBeenCalledWith("pasted.png", png, DIR);
    expect(addBinaryToWorkspace).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("uploads dropped files one by one; one refused keeps the others", async () => {
    const { container } = render(<Composer onSend={vi.fn()} sessionDir={DIR} />);
    const files = [new File(["a,b"], "data.csv"), new File(["x"], "huge.bin")];
    fireEvent.drop(container.firstChild as Element, {
      dataTransfer: { types: ["Files"], files },
    });
    await waitFor(() => expect(screen.getByText("data.csv")).toBeTruthy());
    expect(screen.queryByText("huge.bin")).toBeNull();
    expect(uploadToWorkspace).toHaveBeenCalledTimes(2);
  });

  it("uploads what the picker returns, and deletes the upload when its chip goes", async () => {
    const { container } = render(<Composer onSend={vi.fn()} sessionDir={DIR} />);
    expect(screen.getByLabelText("Add files")).toBeTruthy();
    const picker = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File(["# n"], "notes.md")] } });
    await waitFor(() => expect(screen.getByText("notes.md")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Remove notes.md"));
    expect(discardUpload).toHaveBeenCalledWith("notes.md", DIR);
  });
});
