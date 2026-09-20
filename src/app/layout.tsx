import type { Metadata, Viewport } from "next";
import { AuthProvider } from "@/context/AuthContext";
import "./globals.css";

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
    >
      <body className="min-h-full overflow-hidden antialiased font-arabic">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
