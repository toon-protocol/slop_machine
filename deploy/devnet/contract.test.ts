/**
 * The playback contract, held at its own boundary — ADR 0005.
 *
 * This suite boots the REAL player — a plain Node HTTP server on loopback, no
 * Docker daemon, no chain, no containers — and speaks HTTP at it, which is why
 * it runs in the ordinary `pnpm test` beside the bundle guards while the
 * devnet driver in this same directory does not. It is named by FILE in
 * `vitest.config.ts` for the same reason `bundle.test.ts` is.
 *
 * What it holds still is the contract the eventual toon-client daemon
 * implements from the ADR: the versioned paths, the state's shape, the origin
 * allowlist on the spend-initiating surface, and — by literal — the named
 * invariant: THE BUDGET LIVES ON THE PAYING SIDE OF THE LOOPBACK LINE, AND NO
 * REQUEST ACROSS IT CAN RAISE IT.
 *
 * Boundary only: this suite is the paying side's driver exactly as `demo.ts`
 * is, so it hands the player a state and reads what comes back over HTTP — it
 * never learns how the player holds a window or writes a playlist.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPlayer, type DemoState, type Player } from './player.js';

/** The one station this paying side holds a channel toward. */
const THE_STATION = 'g.toon.slopmachine.0a1b2c3d4e5f';

/** A station this payer holds no channel toward — somebody else's address. */
const A_STATION_THIS_PAYER_CANNOT_PAY = 'g.toon.slopmachine.somebodyelse';

/**
 * The paying side's own figure, and the number the invariant is proved
 * against: the state must report exactly this before AND after every attempt
 * to raise it across the line.
 */
const BUDGET_PER_SECOND = 600n;

/** What a raise attempt asks for — bigger, so "it stood" is not "it matched". */
const A_RAISED_BUDGET = '9000000';

/** The ladder this player synthesizes playlists for, cheapest first. */
const LADDER = ['audio', '480p'];

/** A rung on nobody's ladder here. */
const A_RUNG_THE_STATION_DOES_NOT_OFFER = '1080p';

/** A web page the viber never chose, sharing their browser. */
const A_HOSTILE_ORIGIN = 'http://a-page-the-viber-never-chose.example';

/**
 * A further origin the paying side chose to trust — the seam `demo.ts` fills
 * with the guide's own origin. The allowlist is the paying side's own
 * configuration, so it is handed in here exactly as a demo or a daemon would.
 */
const A_TRUSTED_GUIDE_ORIGIN = 'http://127.0.0.1:4173';

/**
 * What the paying side's driver knows, handed in whole — the same seam
 * `demo.ts` fills from its ledger, filled here with literals so every value
 * the contract reports back can be asserted as one.
 */
const A_DRIVER_STATE: DemoState = {
  live: true,
  waitingFor: 'on the air',
  hubAddress: 'g.toon.slopmachine',
  stationPrefix: THE_STATION,
  handle: '0a1b2c3d4e5f',
  segmentSeconds: 2,
  rungs: [
    {
      rung: 'audio',
      price: '220',
      toStation: '200',
      toHub: '20',
      edge: 41,
      bought: 12,
      spent: '2640',
    },
    {
      rung: '480p',
      price: '1020',
      toStation: '1000',
      toHub: '20',
      edge: 41,
      bought: 0,
      spent: '0',
    },
  ],
  spent: '2930',
  toStation: '2690',
  toHub: '240',
  packets: 14,
  claimed: '0',
  onChain: '0',
  redeeming: false,
  redeemed: null,
};

describe('the playback contract', () => {
  let directory: string;
  let player: Player;
  /** The player's base URL, no trailing slash — also its own page's origin. */
  let base: string;

  const get = (path: string): Promise<Response> => fetch(`${base}${path}`);
  const post = (
    path: string,
    body?: unknown,
    origin?: string
  ): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(origin === undefined ? {} : { origin }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const state = async (): Promise<Record<string, unknown>> =>
    (await (await get('/contract/v1/state')).json()) as Record<string, unknown>;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'playback-contract-'));
    player = await startPlayer({
      // Ephemeral, so this suite never collides with a demo or a sibling fork.
      port: 0,
      rungs: LADDER,
      segmentSeconds: 2,
      directory,
      contract: {
        station: THE_STATION,
        budgetPerSecond: BUDGET_PER_SECOND,
        allowedOrigins: [A_TRUSTED_GUIDE_ORIGIN],
      },
      state: () => A_DRIVER_STATE,
      redeem: async () => {},
    });
    base = player.url.replace(/\/$/, '');
  });

  afterAll(async () => {
    await player.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('binds loopback and nothing else, with no setting that could move it', () => {
    // Serving bought segments off-box would be reselling them, and the
    // contract half initiates spend. The URL the player hands out is the
    // whole of where it can be reached.
    expect(
      player.url.startsWith('http://127.0.0.1:'),
      `the player says it is at ${player.url}`
    ).toBe(true);
  });

  it('serves its state at the versioned path, and names a version it does not speak', async () => {
    const answer = await get('/contract/v1/state');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('application/json');
    // All of this is stale within seconds.
    expect(answer.headers.get('cache-control')).toBe('no-store');

    const body = (await answer.json()) as Record<string, unknown>;
    expect(body['contract']).toBe('v1');

    // A version this side does not speak is answered BY NAME, so a guide can
    // say which side is behind instead of rendering garbage.
    const other = await get('/contract/v2/state');
    expect(other.status).toBe(404);
    expect(((await other.json()) as { error?: string }).error).toBe(
      'unknown_contract_version'
    );

    // And a v1 path this version does not define is a different fact.
    const nonsense = await get('/contract/v1/nonsense');
    expect(nonsense.status).toBe(404);
    expect(((await nonsense.json()) as { error?: string }).error).toBe(
      'unknown_contract_path'
    );
  });

  it("reports the paying side's own facts: prices, the split, the budget, the playlists", async () => {
    const body = await state();

    expect(body['station']).toBe(THE_STATION);
    expect(body['vibing']).toBe(false);
    expect(body['live']).toBe(true);
    expect(body['rung']).toBeNull();
    expect(body['segmentSeconds']).toBe(2);
    // Read-only across the line, and readable because choosing WITHIN a
    // budget requires knowing it.
    expect(body['budgetPerSecond']).toBe('600');
    expect(body['spent']).toBe('2930');
    expect(body['toStation']).toBe('2690');
    expect(body['toHub']).toBe('240');
    expect(body['packets']).toBe(14);

    const rungs = body['rungs'] as Record<string, unknown>[];
    expect(rungs.map((rung) => rung['rung'])).toEqual(['audio', '480p']);
    expect(rungs[0]).toMatchObject({
      rung: 'audio',
      price: '220',
      toStation: '200',
      toHub: '20',
      edge: 41,
      bought: 12,
      spent: '2640',
      playlist: `${base}/hls/audio.m3u8`,
    });

    // A playlist location is a location: it answers, even for a rung nobody
    // has bought at yet — an empty window, never a 404 the guide must special-case.
    for (const rung of rungs) {
      const playlist = await fetch(String(rung['playlist']));
      expect(
        playlist.status,
        `the playlist for ${String(rung['rung'])} does not answer at the location the contract names`
      ).toBe(200);
      expect(playlist.headers.get('content-type')).toBe(
        'application/vnd.apple.mpegurl'
      );
    }
  });

  it('initiates vibing only with the station this payer can pay', async () => {
    // The write's one required key, missing.
    const empty = await post('/contract/v1/vibe', {});
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error?: string }).error).toBe(
      'no_station'
    );

    // A station this payer holds no channel toward. About channels, not
    // directories — discovery is the guide's business, not this surface's.
    const stranger = await post('/contract/v1/vibe', {
      station: A_STATION_THIS_PAYER_CANNOT_PAY,
    });
    expect(stranger.status).toBe(404);
    expect(((await stranger.json()) as { error?: string }).error).toBe(
      'unknown_station'
    );
    expect((await state())['vibing']).toBe(false);

    // The station it can pay — and the answer IS the state, so the guide
    // learns the result from the same shape it learns everything else.
    const vibe = await post('/contract/v1/vibe', { station: THE_STATION });
    expect(vibe.status).toBe(200);
    expect(((await vibe.json()) as { vibing?: boolean }).vibing).toBe(true);

    // And what the paying side's own driver reads is the same fact.
    expect(player.vibing()).toBe(true);

    // Idempotent: vibing while vibing is not an error anybody has to handle.
    expect(
      (await post('/contract/v1/vibe', { station: THE_STATION })).status
    ).toBe(200);
  });

  it('selects a rung the station offers, and refuses one it does not by name', async () => {
    const missing = await post('/contract/v1/rung', {});
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error?: string }).error).toBe(
      'no_rung'
    );

    // The same name the origin's own miss uses, so a guide learns one
    // vocabulary for "that rung is not on this ladder".
    const unknown = await post('/contract/v1/rung', {
      rung: A_RUNG_THE_STATION_DOES_NOT_OFFER,
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error?: string }).error).toBe(
      'unknown_rung'
    );
    expect((await state())['rung']).toBeNull();

    const selected = await post('/contract/v1/rung', { rung: '480p' });
    expect(selected.status).toBe(200);
    expect((await state())['rung']).toBe('480p');
    expect(player.selectedRung()).toBe('480p');
  });

  it('refuses a spend-initiating request from an origin the paying side does not know', async () => {
    // Loopback does not fence the browser: any page a person has open can
    // make the browser POST at 127.0.0.1, and acting does not require
    // reading. The allowlist is the paying side's own configuration.
    const hostile = await post(
      '/contract/v1/stop',
      undefined,
      A_HOSTILE_ORIGIN
    );
    expect(hostile.status).toBe(403);
    expect(((await hostile.json()) as { error?: string }).error).toBe(
      'origin_not_allowed'
    );
    // And nothing happened: the viber is still vibing.
    expect((await state())['vibing']).toBe(true);

    // No CORS grant ever names an origin off the list — a page not on it can
    // neither act nor read.
    expect(hostile.headers.get('access-control-allow-origin')).toBeNull();

    // A hostile preflight is refused too, ahead of any write.
    const preflight = await fetch(`${base}/contract/v1/vibe`, {
      method: 'OPTIONS',
      headers: { origin: A_HOSTILE_ORIGIN },
    });
    expect(preflight.status).toBe(403);

    // While the player's own page — allowlisted by construction — both acts
    // and reads.
    const own = await post('/contract/v1/rung', { rung: 'audio' }, base);
    expect(own.status).toBe(200);
    expect(own.headers.get('access-control-allow-origin')).toBe(base);
    expect((await state())['rung']).toBe('audio');
  });

  it('never lets a request across the loopback line raise the budget', async () => {
    // THE NAMED INVARIANT, BY LITERAL (ADR 0005): the budget lives on the
    // paying side of the loopback line, and no request across it can raise
    // it. The guide chooses within the budget; it never sets it.
    expect((await state())['budgetPerSecond']).toBe('600');

    // The reserved path is refused by name, whatever the method and whatever
    // the body — a client that tries learns the rule, not a 404 that reads as
    // "perhaps in v2".
    const raise = await post('/contract/v1/budget', {
      budgetPerSecond: A_RAISED_BUDGET,
    });
    expect(raise.status).toBe(403);
    expect(((await raise.json()) as { error?: string }).error).toBe(
      'budget_is_not_yours'
    );

    const read = await get('/contract/v1/budget');
    expect(read.status).toBe(403);
    expect(((await read.json()) as { error?: string }).error).toBe(
      'budget_is_not_yours'
    );

    // And a budget smuggled into a legitimate write is refused the same way,
    // never quietly dropped — a guide must not believe it set what it did not.
    const smuggled = await post('/contract/v1/vibe', {
      station: THE_STATION,
      budget: A_RAISED_BUDGET,
    });
    expect(smuggled.status).toBe(403);
    expect(((await smuggled.json()) as { error?: string }).error).toBe(
      'budget_is_not_yours'
    );

    // The budget stood, to the base unit.
    expect((await state())['budgetPerSecond']).toBe('600');
  });

  it('stops vibing on request, and a write path answers only its own method', async () => {
    const wrongMethod = await get('/contract/v1/stop');
    expect(wrongMethod.status).toBe(405);
    expect(((await wrongMethod.json()) as { error?: string }).error).toBe(
      'method_not_allowed'
    );
    expect((await state())['vibing']).toBe(true);

    const stop = await post('/contract/v1/stop');
    expect(stop.status).toBe(200);
    expect((await state())['vibing']).toBe(false);
    expect(player.vibing()).toBe(false);

    // Idempotent, like the vibe.
    expect((await post('/contract/v1/stop')).status).toBe(200);
  });

  it('grants an allowlisted further origin the writes AND the media reads, and no other origin either', async () => {
    // The option is the seam demo.ts fills with the guide's own origin: a
    // web origin the paying side chose to trust both acts on the contract…
    const write = await post(
      '/contract/v1/rung',
      { rung: '480p' },
      A_TRUSTED_GUIDE_ORIGIN
    );
    expect(write.status).toBe(200);
    expect(write.headers.get('access-control-allow-origin')).toBe(
      A_TRUSTED_GUIDE_ORIGIN
    );
    expect((await state())['rung']).toBe('480p');

    // …and reads the state its poll lives on, with the grant that lets a
    // browser deliver the answer.
    const read = await fetch(`${base}/contract/v1/state`, {
      headers: { origin: A_TRUSTED_GUIDE_ORIGIN },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get('access-control-allow-origin')).toBe(
      A_TRUSTED_GUIDE_ORIGIN
    );

    // CORS grants follow the allowlist on reads as well as writes (ADR
    // 0005), and the playlists the state names are exactly such reads: an
    // allowlisted guide plays them with hls.js, whose fetches the browser
    // holds to CORS — without this grant the contract would name locations
    // its own client cannot play.
    const playlist = await fetch(`${base}/hls/audio.m3u8`, {
      headers: { origin: A_TRUSTED_GUIDE_ORIGIN },
    });
    expect(playlist.status).toBe(200);
    expect(playlist.headers.get('access-control-allow-origin')).toBe(
      A_TRUSTED_GUIDE_ORIGIN
    );

    // While a page the viber never chose still gets no grant on the media,
    // exactly as on the contract surface.
    const denied = await fetch(`${base}/hls/audio.m3u8`, {
      headers: { origin: A_HOSTILE_ORIGIN },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});
