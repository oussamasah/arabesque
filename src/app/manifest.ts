import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Café POS",
    short_name: "POS",
    start_url: "/pos",
    scope: "/",
    display: "fullscreen",
    orientation: "landscape",
    background_color: "#f5efe6",
    theme_color: "#6b3a1f",
    lang: "ar",
    dir: "rtl",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
