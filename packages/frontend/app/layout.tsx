import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Katechon Demo",
  description: "Watch AI agents do things in real time.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
