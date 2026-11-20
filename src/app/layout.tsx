import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Café POS",
  description: "إدارة المقهى ومراقبة المخزون",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg" },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
