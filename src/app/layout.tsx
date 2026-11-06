import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";

const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "CallCairn · Never miss an HVAC call again", template: "%s · CallCairn" },
  description:
    "CallCairn answers your missed and after-hours HVAC calls with an AI assistant, texts callers back, sorts emergencies from routine work, and books jobs onto your calendar.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f7fa",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-US" className={`${display.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
