"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { createDataSource, type AppDataSource } from "@/lib/data";

const DataSourceContext = createContext<AppDataSource | null>(null);

export function DataSourceProvider({ children }: { children: ReactNode }) {
  const [ds] = useState(() => createDataSource());
  return (
    <DataSourceContext.Provider value={ds}>{children}</DataSourceContext.Provider>
  );
}

export function useDataSource(): AppDataSource {
  const ds = useContext(DataSourceContext);
  if (!ds) throw new Error("useDataSource must be used inside DataSourceProvider");
  return ds;
}
