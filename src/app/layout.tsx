import type { Metadata, Viewport } from "next";
import { Cairo, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  display: "swap",
});

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "محصولي الذكي · Smart Crop AI",
  description:
    "منصة الذكاء الاصطناعي للفلاحة الدقيقة — تشخيص الأمراض، السقي الذكي ومراقبة الأقمار الصناعية. / Plateforme IA pour l'agriculture de précision.",
  applicationName: "Smart Crop AI",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#10b981",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ar"
      dir="rtl"
      suppressHydrationWarning
      className={`${cairo.variable} ${jakarta.variable}`}
    >
      <body className="min-h-full overflow-hidden antialiased">
        {children}
      </body>
    </html>
  );
}
