import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  const legacy = process.env.PI_COLLAB_MODE === "legacy";
  return {
    id: "/",
    name: legacy ? "Pi Web" : "pi-collab",
    short_name: legacy ? "Pi Web" : "pi-collab",
    description: legacy ? "Local web interface for the pi coding agent" : "多人、多 AI 协作开发平台",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#1a1a1a",
    categories: ["developer", "productivity"],
    lang: legacy ? "en" : "zh-CN",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
