import type { GatewayConfig } from "../config.js";
import { PhotonChannelAdapter } from "../photon/adapter.js";
import type { ChannelAdapter } from "../types.js";

export function createAdapter(config: GatewayConfig): ChannelAdapter {
  return new PhotonChannelAdapter(config);
}
