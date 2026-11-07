import type { NextConfig } from "next";

// The dashboard API lives in app/api (route handlers) and keeps its data in SQLite.
// It talks to REW on this Mac and to the DSP bridge on the Windows laptop, server-side.
const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
