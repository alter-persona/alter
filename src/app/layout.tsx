import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voice Personality Intake",
  description: "Local-only personality interview capture",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="container">{children}</div>
      </body>
    </html>
  );
}
