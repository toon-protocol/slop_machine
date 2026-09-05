/**
 * Rendering both `connector.toml` files, from the templates beside this file
 * into the working directory git ignores.
 *
 * A devnet's connector configuration cannot be committed, for two reasons and
 * either is sufficient: the registry and token addresses are wherever THIS
 * run's replay landed them, and the station's apex is whatever prefix the hub
 * quoted it — which is not known until the hub has been asked, and is the
 * whole subject of the documented order a run walks.
 *
 * So the committed artifact is a template with `{{…}}` in it, and the rendered
 * file is what a container reads. Nothing under `deploy/` or `deploy/hub/` is
 * edited or read as the devnet's own configuration in either direction: those
 * are an operator's files, frozen by their own guards, and pointed at a public
 * chain.
 *
 * ## An unrendered placeholder is a refusal here
 *
 * A `{{TOKEN_ADDRESS}}` that survived into a rendered file reaches the
 * connector as a TOML syntax error or as an address it cannot parse, and the
 * container then exits with a message about the wrong thing entirely. It is
 * cheaper to fail in this function, naming the placeholder nobody filled.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address } from 'viem';
import { HUB_CONNECTOR_TOML, STATION_CONNECTOR_TOML } from './credentials.js';

const TEMPLATES_DIR = resolve(import.meta.dirname, 'templates');

/**
 * The chain, as the CONTAINERS reach it — the compose service, never the
 * loopback publish the driver uses. A container reaching its own host's
 * 127.0.0.1 reaches itself.
 */
export const CHAIN_URL_ON_THE_COMPOSE_NETWORK = 'http://chain:8545';

/** A `{{PLACEHOLDER}}`, and what is left of one nobody filled. */
const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/g;

/** What both templates need to know about the chain this run deployed onto. */
export interface ChainSettings {
  /** The chain's RPC, as the containers reach it. */
  rpcUrl: string;
  /** The TokenNetworkRegistry — never a TokenNetwork; the connector resolves one through it. */
  registry: Address;
  /** The mock token both nodes settle in. */
  token: Address;
  /** What that token reports about itself. A mismatch is a refuse-to-start. */
  decimals: number;
}

function render(template: string, values: Record<string, string>): string {
  const rendered = template.replace(
    PLACEHOLDER,
    (whole, name: string) => values[name] ?? whole
  );

  const unfilled = [...rendered.matchAll(PLACEHOLDER)].map(([, name]) => name);
  if (unfilled.length > 0) {
    throw new Error(
      `the devnet's connector template still holds ${JSON.stringify(unfilled)} after rendering. A placeholder that survives reaches the connector as a TOML error or an unparseable address, and the container then exits complaining about something else.`
    );
  }
  return rendered;
}

function templateFor(name: string): string {
  return readFileSync(resolve(TEMPLATES_DIR, `${name}.toml`), 'utf8');
}

function chainValues(chain: ChainSettings): Record<string, string> {
  return {
    CHAIN_RPC_URL: chain.rpcUrl,
    REGISTRY_ADDRESS: chain.registry,
    TOKEN_ADDRESS: chain.token,
    TOKEN_DECIMALS: String(chain.decimals),
  };
}

/**
 * Render the hub's configuration.
 *
 * `hubAddress` is the apex the hub terminates its two routes beneath, and it
 * is the same value the slot app is given as `TOON_HUB_ADDRESS` in the compose
 * file: a hub whose app and connector disagree about its own name grants
 * prefixes nothing terminates and writes routes nobody addresses.
 */
export function renderHubConnectorToml(
  chain: ChainSettings,
  hubAddress: string
): string {
  const rendered = render(templateFor('hub-connector'), {
    ...chainValues(chain),
    HUB_ADDRESS: hubAddress,
  });
  writeFileSync(HUB_CONNECTOR_TOML, rendered, { mode: 0o644 });
  return rendered;
}

/**
 * Render the station's configuration, beneath `apex`.
 *
 * Called TWICE in a run, and that is the point. `deploy/README.md` tells a
 * broadcaster to pull a quote before editing their `connector.toml`, because
 * the prefix they are reachable at is the one their hub grants; a run renders
 * this at a placeholder apex, boots, quotes, and renders it again at the
 * granted prefix before restarting the node.
 */
export function renderStationConnectorToml(
  chain: ChainSettings,
  apex: string
): string {
  const rendered = render(templateFor('station-connector'), {
    ...chainValues(chain),
    STATION_APEX: apex,
  });
  writeFileSync(STATION_CONNECTOR_TOML, rendered, { mode: 0o644 });
  return rendered;
}
