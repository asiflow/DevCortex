import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { getConnectionConfig } from '@/lib/db';

/** GET /api/user — return the authenticated user's profile. */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (session === null) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Touch the connection config so a misconfigured DATABASE_URL fails loudly.
  const db = getConnectionConfig();

  return NextResponse.json({
    user: {
      id: session.userId,
      email: session.email,
    },
    database: db.database,
  });
}

/** POST /api/user — refresh the profile (no-op write surface for the fixture). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (session === null) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const displayName =
    typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>)['displayName'] === 'string'
      ? (body as Record<string, unknown>)['displayName']
      : session.email;

  return NextResponse.json({
    user: {
      id: session.userId,
      email: session.email,
      displayName,
    },
    refreshedAt: new Date().toISOString(),
  });
}
