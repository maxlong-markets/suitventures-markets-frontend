import type { NextConfig } from "next";
import path from "node:path";

// See src/shims/wagmi-connectors.ts — RainbowKit 2.2.x still imports two
// connectors that wagmi v3 dropped.
const WAGMI_CONNECTORS_SHIM = "./src/shims/wagmi-connectors.ts";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      "wagmi/connectors": WAGMI_CONNECTORS_SHIM,
    },
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "wagmi/connectors": path.resolve(__dirname, WAGMI_CONNECTORS_SHIM),
    };
    return config;
  },
};

export default nextConfig;
