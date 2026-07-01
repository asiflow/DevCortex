import type { Metadata } from 'next';
import type { ReactNode } from 'react';

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  title: {
    default: 'Sample Next App',
    template: '%s · Sample Next App',
  },
  description: 'DevCortex scan/gate fixture — a minimal but real Next.js App Router project.',
  metadataBase: new URL(appUrl),
};

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        <header>
          <a href="/">Sample Next App</a>
          <nav>
            <a href="/dashboard">Dashboard</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer>
          <small>Served from {appUrl}</small>
        </footer>
      </body>
    </html>
  );
}
