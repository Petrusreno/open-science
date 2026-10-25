// Tell `osd` which conversation a command comes from.
//
// An agent can read and message other sessions and terminals with `osd`
// (`osd session send`, `osd term send`). OpenCode fires `shell.env` before
// every command an agent runs, with the session it runs for; this puts that
// session in the command's environment as OSD_ORIGIN_SESSION, and `osd` sends
// it along. The gateway records it in the audit log and limits how fast one
// conversation may message others, so two agents cannot talk to each other
// without end.
//
// A terminal the user opens fires the same hook with no session: nothing is set.

// Only the factory is exported: OpenCode calls every export as a plugin factory.
export const OriginPlugin = async () => ({
  "shell.env": async (input: { sessionID?: unknown }, output: { env?: Record<string, string> }) => {
    // Runs before every command; a throw would fail the command itself.
    try {
      if (typeof input?.sessionID === "string" && output?.env) {
        output.env.OSD_ORIGIN_SESSION = input.sessionID;
      }
    } catch {
      // The command runs without an origin, as it did before this plugin.
    }
  },
});
