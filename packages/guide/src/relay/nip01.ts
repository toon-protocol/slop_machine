/**
 * The guide's own NIP-01 reader — one REQ over one WebSocket, hand-rolled on
 * purpose.
 *
 * NIP-01's read side is a few JSON frames, and the alternative to these fifty
 * lines is a dependency. The obvious one is the devnet's own announcement
 * SIGNER, and it is devnet-only by a fence the bundle guard enforces:
 * announcing is the broadcaster's client-side act (ADR 0004), and nothing
 * under `packages/` may so much as name that package. The guide never signs —
 * it only reads what a relay serves — so it takes the smallest thing that
 * reads, which is this.
 *
 * Deliberately unverified: checking an event's `sig` needs a signing-curve
 * dependency the payment-free guard forbids by prefix, and an announcement is
 * a claim by the broadcaster either way — the relay it was paid onto is the
 * v1 trust boundary, and ADR 0004's first-mover dedupe is the defense that
 * remains the consumer's own.
 *
 * The subscription STAYS OPEN after EOSE: a heartbeat republished while the
 * guide is on screen arrives as a live EVENT frame, which is half of what
 * keeps the live badge honest without a reload (the other half is the clock —
 * `stations-context.tsx`). A dropped socket redials on a short delay, because
 * a demo restarted under an open tab should come back on its own.
 */

/** A NIP-01 event as a relay serves it. `sig` rides along unverified. */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface RelaySubscription {
  close(): void;
}

const SUBSCRIPTION_ID = 'guide-discovery';
const REDIAL_DELAY_MS = 5_000;

/**
 * Open one subscription for the given kinds and hand every event up, from
 * the stored backlog and live thereafter. Returns a handle whose `close`
 * ends the subscription and stops any redial. `authors` narrows the filter
 * to those pubkeys — how the broadcaster page asks for one broadcaster's
 * clips rather than everybody's.
 */
export function subscribeToRelay(
  relayUrl: string,
  kinds: number[],
  onEvent: (event: NostrEvent) => void,
  authors?: string[]
): RelaySubscription {
  let socket: WebSocket | null = null;
  let redial: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const dial = (): void => {
    socket = new WebSocket(relayUrl);

    socket.addEventListener('open', () => {
      socket?.send(
        JSON.stringify([
          'REQ',
          SUBSCRIPTION_ID,
          { kinds, ...(authors === undefined ? {} : { authors }) },
        ])
      );
    });

    socket.addEventListener('message', (message: MessageEvent) => {
      let frame: unknown[];
      try {
        frame = JSON.parse(String(message.data)) as unknown[];
      } catch {
        return; // Not this relay's JSON is not this reader's problem.
      }
      if (frame[0] === 'EVENT' && frame[1] === SUBSCRIPTION_ID) {
        onEvent(frame[2] as NostrEvent);
      }
      // EOSE is deliberately nothing here: the backlog has been served and
      // the same subscription keeps carrying what arrives from now on.
    });

    socket.addEventListener('close', () => {
      if (closed) return;
      redial = setTimeout(dial, REDIAL_DELAY_MS);
    });
    // An error is followed by a close event, which is where the redial lives.
  };

  dial();

  return {
    close(): void {
      closed = true;
      if (redial !== null) clearTimeout(redial);
      socket?.close();
    },
  };
}
