import type { Metadata } from "next";
import "./globals.css";
import AuthProvider from "@/components/auth/AuthProvider";
import ThemeProvider from "@/components/theme/ThemeProvider";
import AppShell from "@/components/layout/AppShell";
import CompanyScopeProvider from "@/components/company/CompanyScopeProvider";
import DateFormatProvider from "@/components/date-format/DateFormatProvider";

export const metadata: Metadata = {
  title: "Training Tracker",
  description: "Student Certification & Training Tracker",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider>
          <AuthProvider>
            <DateFormatProvider>
              <CompanyScopeProvider>
                <AppShell>{children}</AppShell>
              </CompanyScopeProvider>
            </DateFormatProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
