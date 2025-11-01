import type { Metadata } from "next";

import "nes.css/css/nes.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "CrewTalk Control Center",
  description: "Manage CrewTalk sessions and monitor LLM availability.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
