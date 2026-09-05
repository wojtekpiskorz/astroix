import { connect } from 'node:net';
import type { RequestEnvelope, ResourceGrant } from '@wojciechpiskorz/astroix-protocol';
import { rawExchange } from '../../../src/e2e-wire.ts';
import type { AbaCapture } from '../harness/aba.ts';

/**
 * The K3 scenario wire drivers (#256): the raw-socket exchanges this
 * lane's proofs need that the A-B-A harness does not carry — the
 * served write fact (the grant a hostile or held mutation needs) and
 * the held-body mutation (a noncooperative write whose body completes
 * only when the scenario finishes it). They ride the SAME
 * `rawExchange` socket base the lane's wire probes already use
 * (`apps/web/src/e2e-wire.ts`, single-homed), spell the admission's
 * own evidence exactly the way the runtime tier's K harness does, and
 * consume the harness's `AbaCapture` as their authority input — never
 * a re-derived switch sequence.
 *
 * The stylesWriteFact spelling consumes the CURRENT envelope shape
 * (`result.result.payload.writeFacts[]`) — the #423 advisory note's
 * weigh-in is recorded in the lane's PR: the shape is consumed as it
 * serves, and #425's single-homing stays as filed.
 */

/** One served sheet's write fact — the grant plus the raw bytes, off the live wire. */
export interface StylesWriteFact {
  readonly file: string;
  readonly grant: ResourceGrant;
  readonly raw: string;
}

/** The session pair a capture names — the envelope's own `session` shape. */
function sessionOf(capture: AbaCapture): { runtimeEpoch: string; generation: number } {
  return { runtimeEpoch: capture.runtimeEpoch, generation: capture.generation };
}

/** The POST head's exact evidence — the admission spine's own demand, one spelling here. */
function postHead(host: string, capture: AbaCapture, body: string, mutation: boolean): string {
  return [
    'POST /__astroix/api/v1 HTTP/1.1',
    `Host: ${host}`,
    `Cookie: __astroix_host=${capture.hostCapability}`,
    `X-Astroix-Client: ${capture.clientCapability}`,
    'Content-Type: application/json',
    ...(mutation
      ? [`Origin: http://${host}`, 'X-Astroix-Request: 1']
      : ['Sec-Fetch-Site: same-origin']),
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
}

/**
 * The served sheet's write fact for the staged CSS file — an admitted
 * styles inspection under the capture's live authority, parsed out of
 * the CURRENT envelope shape. The scenario-side spelling of the
 * runtime harness's member for the web tier (this lane's own surface;
 * the harness is forbidden to edit here).
 */
export async function stylesWriteFactOf(
  port: number,
  capture: AbaCapture,
): Promise<StylesWriteFact> {
  const envelope: RequestEnvelope = {
    protocolVersion: 1,
    requestId: 'k3-styles-fact',
    session: sessionOf(capture),
    command: { kind: 'inspect', request: { kind: 'styles', route: '/' } },
  };
  const response = await rawExchange(
    port,
    `${postHead(capture.host, capture, JSON.stringify(envelope), false)}${JSON.stringify(envelope)}`,
  );
  const payload = JSON.parse(response.body) as {
    result?: {
      result?: {
        payload?: {
          writeFacts?: { file: string; grant: ResourceGrant; raw: string }[];
        };
      };
    };
  };
  const fact = payload.result?.result?.payload?.writeFacts?.find(
    (entry) => entry.file === 'src/pages/home.css',
  );
  if (response.status !== 200 || fact === undefined) {
    throw new Error(
      `the styles inspection carried no write fact for the staged sheet (${response.status})`,
    );
  }
  return fact;
}

/**
 * A mutation whose body has not completed yet — `finish()` lands it,
 * bounded like the socket base beneath it (a 5 s destroy-and-settle
 * timer, never a hung leg).
 */
export interface HeldBodyMutation {
  finish(): Promise<{ readonly status: number; readonly body: string }>;
}

/**
 * One apply-edit whose body is held at `splitAt` bytes: the head and
 * the first half cross, the body completes only when the scenario
 * finishes it — the noncooperative write that trails a transition.
 * The envelope rides VERBATIM, so `splitAt` indexes the actual sent
 * serialization.
 */
export function openHeldBodyMutation(
  port: number,
  envelope: RequestEnvelope,
  capture: AbaCapture,
  splitAt: number,
): HeldBodyMutation {
  const body = JSON.stringify(envelope);
  const socket = connect({ host: '127.0.0.1', port });
  socket.on('connect', () => {
    socket.write(postHead(capture.host, capture, body, true));
    socket.write(body.slice(0, splitAt));
  });
  socket.on('error', () => socket.destroy());
  return {
    finish: () =>
      new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        // The rawExchange base's own bound, mirrored: destroy and settle,
        // never a hung leg — the close the timer forces lands in the same
        // settle as a natural one.
        const timer = setTimeout(() => {
          socket.destroy();
          settle();
        }, 5_000);
        const settle = (): void => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString('latin1');
          const split = text.indexOf('\r\n\r\n');
          const status = Number.parseInt(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? '0', 10);
          resolve({ status, body: split === -1 ? '' : text.slice(split + 4) });
        };
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('error', (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.on('close', settle);
        socket.write(body.slice(splitAt));
      }),
  };
}
