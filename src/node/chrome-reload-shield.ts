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
      for (const client of channel.clients) {
        if (!chromeClients.has(client)) client.send(payload);
      }
      return;
    }
    broadcast(payload, ...rest);
  };
}
