import type { MarketsDataSource } from "@/lib/types";
import { EnvioDataSource } from "./envio";
import { MockDataSource } from "./mock";

export type AppDataSource = MockDataSource | EnvioDataSource;

/** Picks the data layer from NEXT_PUBLIC_DATA_SOURCE; mock unless told otherwise. */
export function createDataSource(): AppDataSource {
  if (process.env.NEXT_PUBLIC_DATA_SOURCE === "envio") return new EnvioDataSource();
  return new MockDataSource();
}

export function isMockSource(ds: MarketsDataSource): ds is MockDataSource {
  return ds instanceof MockDataSource;
}
