import type { Metadata } from "next";
import { Young_Serif, Atkinson_Hyperlegible, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import audit from "../bench/audit.json";

const display = Young_Serif({ variable: "--font-young-serif", weight: "400", subsets: ["latin"] });
const body = Atkinson_Hyperlegible({ variable: "--font-atkinson", weight: ["400", "700"], subsets: ["latin"] });
const data = IBM_Plex_Mono({ variable: "--font-plex-mono", weight: ["400", "500"], subsets: ["latin"] });

// Bump OG_IMAGE's version whenever public/og-image.png changes: Discord, X and Slack cache cards by URL (social-card trap 1).
const OG_IMAGE = "/og-image.png?v=qa5";
// The counts come from the committed hand check, so a bench re-run (D20) updates the alt with the image (QA round 5)
const [A, B] = [audit.arms.A, audit.arms.B];
const OG_ALT = `Rekindle: hand-checked, the same LLM got ${A.violations} of ${A.checked} named venues wrong and Rekindle ${B.violations} of ${B.checked}; beside it, week two re-planned live from a fictional patient's ratings.`;

export const metadata: Metadata = {
  metadataBase: new URL("https://rekindle.edycu.dev"),
  title: "Rekindle",
  description:
    "A behavioral-activation planning agent for clinicians: a verified, clinician-approved week of real activities from what a patient used to love, via Qloo.",
  // the SVG for every browser that takes one; /favicon.ico (16 + 32) and the 180 px touch icon for the clients that ask
  // for those paths by convention (iOS home screen, some unfurlers and feed readers): /favicon.ico was a 404 (QA 2026-10-09)
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    title: "Rekindle",
    siteName: "Rekindle",
    description:
      "Turns what a patient used to love into a clinician-approved week of real, open, nearby activities, re-planned from ratings.",
    url: "https://rekindle.edycu.dev",
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: OG_ALT }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Rekindle",
    description:
      "Turns what a patient used to love into a clinician-approved week of real, open, nearby activities, re-planned from ratings.",
    images: [{ url: OG_IMAGE, alt: OG_ALT }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${data.variable}`}>
      <body>{children}</body>
    </html>
  );
}
