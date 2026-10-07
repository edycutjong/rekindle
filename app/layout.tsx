import type { Metadata } from "next";
import { Young_Serif, Atkinson_Hyperlegible, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const display = Young_Serif({ variable: "--font-young-serif", weight: "400", subsets: ["latin"] });
const body = Atkinson_Hyperlegible({ variable: "--font-atkinson", weight: ["400", "700"], subsets: ["latin"] });
const data = IBM_Plex_Mono({ variable: "--font-plex-mono", weight: ["400", "500"], subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://rekindle-one.vercel.app"),
  title: "Rekindle",
  description:
    "A behavioral-activation planning agent for clinicians: a verified, clinician-approved week of real activities built from what a patient used to love, via Qloo.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "Rekindle",
    siteName: "Rekindle",
    description:
      "Turns what a patient used to love into a clinician-approved week of real, open, nearby activities, re-planned from pleasure ratings.",
    url: "https://rekindle-one.vercel.app",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Rekindle" }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Rekindle",
    description:
      "Turns what a patient used to love into a clinician-approved week of real, open, nearby activities, re-planned from pleasure ratings.",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${data.variable}`}>
      <body>{children}</body>
    </html>
  );
}
