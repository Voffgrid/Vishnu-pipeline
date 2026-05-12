import type { Metadata } from "next";
import { Ysabeau, Ysabeau_Infant, DM_Mono } from "next/font/google";
import "./globals.css";

const ysabeau = Ysabeau({
  variable: "--font-ysabeau",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const ysabeauInfant = Ysabeau_Infant({
  variable: "--font-ysabeau-infant",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  subsets: ["latin"],
  weight: ["300", "400", "500"],
});

export const metadata: Metadata = {
  title: "Vishnu Pipeline",
  description: "Script-to-video AI pipeline",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${ysabeau.variable} ${ysabeauInfant.variable} ${dmMono.variable} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <body
        className="min-h-full flex flex-col bg-[#0f0f0f]"
        style={{ fontFamily: "var(--font-ysabeau), sans-serif" }}
      >
        {children}
      </body>
    </html>
  );
}
