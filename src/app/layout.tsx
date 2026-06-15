import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "whale",
  description: "Strategy brain on top of krill: capture → distill → plan → triage → execute.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body className="font-mono bg-bg text-text antialiased min-h-screen">{children}</body>
    </html>
  );
}
