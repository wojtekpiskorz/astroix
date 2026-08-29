import type { ViteDevServer } from 'vite';

/**
 * The chrome's full-reload shield (spec #13/#74): Astro's content sync
 * broadcasts a vite `full-reload` to every connected page — the canvas
 * iframe is one (it reloads exactly as Astro intends, the live preview), but
 * so is the chrome, whose in-memory session (open tab, active entry, dirty
 * draft) a reload would destroy on every write pause. The chrome announces
 * itself over the hot channel; the shield reroutes `full-reload` broadcasts
 * around announced clients only — every other page (canvas, the host
 * developer's own tabs) keeps Astro's behavior untouched. Custom events and
 * module updates flow to everyone as before; a vite whose internals move
 * past this seam degrades to today's behavior (the chrome reloads).
 */

/** The public slice of vite's per-socket client wrapper the shield consumes. */
interface HotClient {
  send: (payload: unknown) => void;
  /** WebSocket readyState — 1 is OPEN; sends on dead sockets throw. */
  socket: { readyState: number };
}

/** The structural slice of vite's ws wrapper (`server.ws`/`server.hot`). */
interface HotChannel {
  // the wrapper accepts both a payload object and the (event, data) custom form
  send: (payload: unknown, ...rest: unknown[]) => void;
  on: (event: string, handler: (data: unknown, client: HotClient) => void) => void;
  clients: Set<HotClient>;
}

export function registerChromeReloadShield(server: ViteDevServer): void {
  const channel = server.ws as unknown as HotChannel;
  const chromeClients = new Set<HotClient>();

  channel.on('astroix:chrome', (_data, client) => {
    chromeClients.add(client);
  });

  const broadcast = channel.send.bind(channel);
  channel.send = (payload: unknown, ...rest: unknown[]) => {
    if (
      typeof payload === 'object' &&
      (payload as { type?: string } | null)?.type === 'full-reload'
    ) {
      // vite's own broadcast only sends to OPEN sockets — a send on a dying
      // one throws, and the throw would kill whatever pipeline called us
      // (astro's content sync wedges mid-flight); skip exactly like vite,
      // and never let a stray send failure escape either
      for (const client of channel.clients) {
        if (chromeClients.has(client) || client.socket.readyState !== 1) continue;
        try {
          client.send(payload);
        } catch {
          // the socket died between the check and the send — its page
          // reconnects and reloads on the next broadcast
        }
      }
      return;
    }
    broadcast(payload, ...rest);
  };
}
