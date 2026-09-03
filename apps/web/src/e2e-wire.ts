import { connect } from 'node:net';

/**
 * The raw-socket wire helpers of the web host's Playwright lane (#240):
 * loopback exchanges with exact request bytes in — status, head, and
 * body out (the runtime lanes' idiom) — the honest way to pin
 * listener-level laws (unknown-host refusals, the retired host's 421)
 * and admission-level laws (the stale-session refusal under a LIVE
 * binding with a STALE pair) that a browser document cannot forge
 * headers or envelopes for.
 */

/** One raw HTTP/1.1 exchange's honest accounting. */
export interface RawExchange {
  readonly status: number;
  readonly body: string;
}

/** Sends exact bytes and collects the whole response — bounded, never hanging a leg. */
export function rawExchange(port: number, request: string, timeoutMs = 5000): Promise<RawExchange> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(request);
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      finish();
    }, timeoutMs);
    const finish = (): void => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('latin1');
      const match = /^HTTP\/1\.1 (\d{3})/.exec(text);
      const split = text.indexOf('\r\n\r\n');
      resolve({
        status: match === null ? 0 : Number.parseInt(match[1] ?? '0', 10),
        body: split === -1 ? '' : text.slice(split + 4),
      });
    };
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', finish);
  });
}

/** One raw GET — status only (the F1 lane's rawStatus idiom, over rawExchange). */
export async function rawStatus(port: number, request: string, timeoutMs = 5000): Promise<number> {
  return (await rawExchange(port, request, timeoutMs)).status;
}
