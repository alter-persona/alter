import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // archiver and prisma run in Node API routes only.
  serverExternalPackages: ["archiver", "@prisma/client"],
};

export default nextConfig;
