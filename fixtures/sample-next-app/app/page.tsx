import Link from 'next/link';
import { Button } from '@/components/Button';

export default function HomePage(): React.JSX.Element {
  return (
    <section>
      <h1>Welcome</h1>
      <p>
        This is a minimal but real Next.js 15 App Router application used as a DevCortex
        scan and gate target. It exposes a public landing page, a protected dashboard, and a
        JSON API.
      </p>
      <Link href="/dashboard">
        <Button variant="primary">Open dashboard</Button>
      </Link>
    </section>
  );
}
