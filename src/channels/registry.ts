import { type ChannelName, type GatewayConfig, getEnabledChannelNames } from "../config.js";
import type { ChannelAdapter } from "../types.js";
import { errorMessage } from "./utils.js";

/**
 * Adapter module convention: `src/channels/<channel>.ts` exports
 *   `createAdapter(config: GatewayConfig): ChannelAdapter`
 * where the returned adapter's `name` equals `<channel>` (photon, telegram, discord,
 * slack, feishu, dingtalk, onebot, webhook). Modules are loaded lazily so a missing or
 * broken channel never prevents the others from starting.
 */
export interface AdapterFactoryModule {
  createAdapter(config: GatewayConfig): ChannelAdapter;
}

export interface CreateAdaptersResult {
  adapters: ChannelAdapter[];
  /** Channels that are configured but whose adapter module failed to load/construct. */
  errors: Partial<Record<ChannelName, string>>;
}

export async function createEnabledAdapters(
  config: GatewayConfig,
  only?: readonly string[],
): Promise<CreateAdaptersResult> {
  const names = getEnabledChannelNames(config).filter(
    (name) => !only || only.includes(name),
  );
  const adapters: ChannelAdapter[] = [];
  const errors: Partial<Record<ChannelName, string>> = {};

  for (const name of names) {
    try {
      const specifier = `./${name}.js`;
      const mod = (await import(specifier)) as Partial<AdapterFactoryModule>;
      if (typeof mod.createAdapter !== "function") {
        throw new Error(`module ./${name} does not export createAdapter(config)`);
      }
      adapters.push(mod.createAdapter(config));
    } catch (err) {
      errors[name] = errorMessage(err);
    }
  }
  return { adapters, errors };
}
