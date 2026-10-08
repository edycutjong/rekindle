import type { Metadata } from "next";
import { Young_Serif, Atkinson_Hyperlegible, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const display = Young_Serif({ variable: "--font-young-serif", weight: "400", subsets: ["latin"] });
const body = Atkinson_Hyperlegible({ variable: "--font-atkinson", weight: ["400", "700"], subsets: ["latin"] });
const data = IBM_Plex_Mono({ variable: "--font-plex-mono", weight: ["400", "500"], subsets: ["latin"] });

// Bump OG_IMAGE's version whenever public/og-image.png changes: Discord, X and Slack cache cards by URL (social-card trap 1).
const OG_IMAGE = "/og-image.png?v=d14a";
const OG_ALT =
  "Rekindle: hand-checked, the same LLM got 7 of 17 named venues wrong and Rekindle 0 of 14; beside it, week two re-planned live from a fictional patient's ratings.";

export const metadata: Metadata = {
  metadataBase: new URL("https://rekindle.edycu.dev"),
  title: "Rekindle",
  description:
    "A behavioral-activation planning agent for clinicians: a verified, clinician-approved week of real activities from what a patient used to love, via Qloo.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "Rekindle",
    siteName: "Rekindle",
    description:
      "Turns what a patient used to love into a clinician-approved week of real, open, nearby places, re-planned from her ratings.",
    url: "https://rekindle.edycu.dev",
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: OG_ALT }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Rekindle",
    description:
      "Turns what a patient used to love into a clinician-approved week of real, open, nearby places, re-planned from her ratings.",
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
