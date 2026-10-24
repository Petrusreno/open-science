// How many tabs of the web client this browser has open.
//
// Every tab holds one connection (see gatewayMux) and a browser allows six per
// address, so past a few tabs each one waits on the others: measured, up to
// three answer a request in about 0.1 s, at four about 1.2 s. A new tab counts
// the others by roll call over a BroadcastChannel and says so.
const CHANNEL = "osd-tabs";

/** From this many tabs on, every tab is noticeably slower. */
export const MANY_TABS = 4;

/** This tab plus every other open one that answers within `waitMs`. Then this
 *  tab answers later newcomers for as long as it is open. */
export function rollCall(waitMs = 400): Promise<number> {
  if (typeof BroadcastChannel === "undefined") return Promise.resolve(1);
  return new Promise((resolve) => {
    let others = 0;
    const ask = new BroadcastChannel(CHANNEL);
    ask.onmessage = (e) => {
      if (e.data === "here") others++;
    };
    ask.postMessage("who");
    setTimeout(() => {
      ask.close();
      // Only now: a channel of this tab's own would hear its own question.
      const answer = new BroadcastChannel(CHANNEL);
      answer.onmessage = (e) => {
        if (e.data === "who") answer.postMessage("here");
      };
      resolve(others + 1);
    }, waitMs);
  });
}
