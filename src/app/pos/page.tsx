import type { Metadata, Viewport } from "next";
import PosApp from "@/pos/PosApp";
import { CacheAssets } from "@/pos/CacheAssets";

export const metadata: Metadata = { title: "POS" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false, themeColor: "#6b3a1f" };

export default function PosPage() {
  return (
    <>
      <PosApp />
      <CacheAssets />
    </>
  );
}
