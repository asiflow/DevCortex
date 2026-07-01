import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { Button } from '@/components/Button';

export const metadata: Metadata = {
  title: 'Dashboard',
};

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const session = await getSession();
  if (session === null) {
    redirect('/?signin=required&from=/dashboard');
  }

  return (
    <section>
      <h1>Dashboard</h1>
      <p>
        Signed in as <strong>{session.email}</strong>.
      </p>
      <form action="/api/user" method="post">
        <Button variant="secondary" type="submit">
          Refresh profile
        </Button>
      </form>
    </section>
  );
}
