/**
 * The relay forwarder — free NIP-01 reads, carried over the viewer's own
 * circuit to their own loopback.
 *
 * ## Why it exists
 *
 * The hosted guide (GitHub Pages) reads the relay at `ws://127.0.0.1:7100` —
 * each reader's own machine, because a public page cannot know anybody's
 * relay. On the demo HOST that address is the compose bundle's own loopback
 * publish. A remote viewer has no such publish: their relay surface is the
 * guide hidden service's port 7100, reachable only through a circuit — and a
 * browser cannot dial a hidden service by any route. So the viewer's driver
 * listens on its own `127.0.0.1:7100` and pipes each connection through the
 * viewer's SOCKS proxy to the guide service, which is what makes the hosted
 * guide's grid light up on a machine that holds nothing but `demo:viewer`.
 *
 * ## What it deliberately is not
 *
 * It carries the relay's FREE reads and nothing else — no payment, no
 * budget, no contract surface; those stay with the paying side exactly where
 * ADR 0005 puts them. It binds loopback only and takes no setting that could
 * move it, for the player's own reason: what it hands out is for this
 * machine's reader. And it is plain `node:net` with the SOCKS5 CONNECT
 * hand-rolled — two request/reply exchanges — because a dependency for
 * twenty bytes of protocol would be a dependency nobody can account for.
 *
 * The listener is `unref()`ed, the lesson `guide-server.ts` taught: a run
 * that dies on its way out must not be held open by a convenience.
 */

import { connect, createServer, type Server, type Socket } from 'node:net';

/** The one interface the forwarder may ever bind. Not a setting: see above. */
const LOOPBACK = '127.0.0.1';

/** How long a circuit gets to come up behind one CONNECT before it is a miss. */
const CONNECT_TIMEOUT_MS = 60_000;

/** A SOCKS5 exchange that did not end in a connected stream, named. */
export class SocksConnectError extends Error {
  override readonly name = 'SocksConnectError';
}

/**
 * One SOCKS5 CONNECT, by hand: greeting `05 01 00` answered `05 00` (no
 * auth), then request `05 01 00 03 <len> <host> <port BE>` answered
 * `05 00 00 <ATYP> <bound addr> <port>`. Anything the proxy pushes after its
 * reply belongs to the target and is handed back as `leftover`.
 */
function socksConnect(options: {
  socksHost: string;
  socksPort: number;
  targetHost: string;
  targetPort: number;
}): Promise<{ socket: Socket; leftover: Buffer }> {
  return new Promise((connected, refused) => {
    const socket = connect(options.socksPort, options.socksHost);
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    let held = Buffer.alloc(0);
    /** 0: awaiting method selection; 1: awaiting the CONNECT reply. */
    let stage: 0 | 1 = 0;

    const fail = (why: string): void => {
      socket.destroy();
      refused(new SocksConnectError(why));
    };

    socket.once('error', (cause) => {
      refused(
        new SocksConnectError(`the SOCKS proxy refused: ${cause.message}`)
      );
    });
    socket.once('timeout', () => {
      fail(
        `the SOCKS proxy did not finish a CONNECT to ${options.targetHost}:${String(options.targetPort)} within ${String(CONNECT_TIMEOUT_MS / 1000)}s`
      );
    });

    const onData = (chunk: Buffer): void => {
      held = Buffer.concat([held, chunk]);

      if (stage === 0) {
        if (held.length < 2) return;
        if (held[0] !== 0x05 || held[1] !== 0x00) {
          return fail(
            `the SOCKS proxy answered method ${String(held[1])} — it is not the no-auth SOCKS5 an anon daemon serves`
          );
        }
        held = held.subarray(2);
        stage = 1;

        const host = Buffer.from(options.targetHost, 'ascii');
        const request = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
          host,
          Buffer.from([options.targetPort >> 8, options.targetPort & 0xff]),
        ]);
        socket.write(request);
        return;
      }

      // The CONNECT reply: 4 bytes, then an address whose length the ATYP
      // decides, then 2 port bytes. Consumed exactly, so target bytes that
      // arrive in the same segment are not eaten.
      if (held.length < 4) return;
      if (held[0] !== 0x05)
        return fail('the SOCKS proxy is not speaking SOCKS5');
      if (held[1] !== 0x00) {
        return fail(
          `the circuit could not reach ${options.targetHost}:${String(options.targetPort)} (SOCKS reply ${String(held[1])})`
        );
      }
      const atyp = held[3];
      const addressLength =
        atyp === 0x01
          ? 4
          : atyp === 0x04
            ? 16
            : atyp === 0x03
              ? 1 + (held[4] ?? 0)
              : -1;
      if (addressLength === -1) {
        return fail(
          `the SOCKS proxy bound an address of unknown type ${String(atyp)}`
        );
      }
      const replyLength = 4 + addressLength + 2;
      if (held.length < replyLength) return;

      const leftover = held.subarray(replyLength);
      socket.removeListener('data', onData);
      socket.setTimeout(0);
      socket.removeAllListeners('error');
      socket.removeAllListeners('timeout');
      connected({ socket, leftover: Buffer.from(leftover) });
    };

    socket.on('data', onData);
    socket.once('connect', () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
  });
}

export interface RelayForwarder {
  /** Where this machine's reader dials the relay: loopback, the listen port. */
  url: string;
  close: () => Promise<void>;
}

/**
 * Listen on loopback and carry every connection through the SOCKS proxy to
 * the target. A pair lives and dies together: an error or a close on either
 * side destroys both, because a half-piped websocket is a grid that hangs
 * rather than one that says so.
 */
export async function startRelayForwarder(options: {
  listenPort: number;
  socksHost: string;
  socksPort: number;
  targetHost: string;
  targetPort: number;
}): Promise<RelayForwarder> {
  const open = new Set<Socket>();

  const server: Server = createServer((client) => {
    open.add(client);
    client.once('close', () => open.delete(client));
    // Buffered until the circuit answers; pipe() resumes the flow.
    client.pause();

    socksConnect({
      socksHost: options.socksHost,
      socksPort: options.socksPort,
      targetHost: options.targetHost,
      targetPort: options.targetPort,
    }).then(
      ({ socket: upstream, leftover }) => {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        open.add(upstream);
        upstream.once('close', () => open.delete(upstream));

        if (leftover.length > 0) client.write(leftover);
        client.pipe(upstream);
        upstream.pipe(client);

        const both = (): void => {
          client.destroy();
          upstream.destroy();
        };
        client.on('error', both);
        upstream.on('error', both);
        client.once('close', both);
        upstream.once('close', both);
      },
      () => {
        // The circuit did not answer for this one connection; the reader's
        // websocket reconnects on its own schedule.
        client.destroy();
      }
    );
  });

  await new Promise<void>((listening, refused) => {
    server.once('error', refused);
    server.listen(options.listenPort, LOOPBACK, () => {
      listening();
    });
  });
  // The forwarder must never hold a dying run open: it is a convenience for
  // a browser, not a participant in the run.
  server.unref();

  return {
    url: `http://${LOOPBACK}:${String(options.listenPort)}`,
    close: () =>
      new Promise<void>((closed) => {
        for (const socket of open) socket.destroy();
        server.close(() => {
          closed();
        });
      }),
  };
}
