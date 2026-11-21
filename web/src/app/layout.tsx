import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { AppShell } from "@/components/shell/AppShell";
import "./globals.css";

const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const display = Instrument_Serif({ variable: "--font-display", subsets: ["latin"], weight: "400", style: ["normal", "italic"] });

const TITLE = "Covenant — Locked for holders. Managed for the market.";
const DESCRIPTION = "A Uniswap v4 hook that lets a curator actively manage launch liquidity it can never withdraw. Live on Base Sepolia.";

// Links to the app unfurl with a card: a screenshot of the CVNT vault page on Base Sepolia (public/og.jpg), taken on
// 2026-11-17 and dated as such. On Vercel the production domain is known at build time; anywhere else the card's URLs
// are relative to the local server.
const SITE = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Covenant",
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
    images: [{ url: "/og.jpg", width: 1200, height: 630, alt: "The CVNT vault page on Base Sepolia, as it was on 17 Nov 2026: its price, value and liquidity shape" }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.jpg"] },
};

const themeBoot = `try{var t=localStorage.getItem("covenant-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body className={`${sans.variable} ${mono.variable} ${display.variable} antialiased`}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
