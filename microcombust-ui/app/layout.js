import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Same families and weights as the AETHON reference file.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
});

export const metadata = {
  title: "AETHON - NASA Microgravity Combustion & Fire Safety AI Platform",
  description: "NASA Microgravity Combustion & Fire Safety AI Platform",
};

// Next.js App Router: viewport / color-scheme live in their own export.
// viewportFit "cover" lets the page draw under notches; the sticky header in
// Dashboard.jsx pads the top safe-area inset and globals.css pads the bottom.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
  themeColor: "#000000",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${jetBrainsMono.variable} antialiased`}
      style={{ colorScheme: "dark", backgroundColor: "#000" }}
    >
      {/* No flex/h-full wrappers: keeps window scrolling plain so the
          sticky header behaves exactly as in the reference file. */}
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
