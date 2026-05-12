import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ffmpeg-static", "@ffmpeg-installer/ffmpeg"],
};

export default nextConfig;
