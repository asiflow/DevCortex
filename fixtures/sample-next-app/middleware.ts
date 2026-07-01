/**
 * Edge middleware: session-cookie auth gate.
 *
 * Runs before protected routes and performs the cheap, Edge-safe structural
 * check from `lib/auth`. Unauthenticated browser requests are redirected to the
 * sign-in surface; unauthenticated API requests get a 401. Full signature
 * verification happens server-side inside the route handlers / server components.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, hasValidSessionShape } from '@/lib/auth';

const PROTECTED_PATTERNS: RegExp[] = [/^\/dashboard(?:\/|$)/, /^\/api\/user(?:\/|$)/];

function isProtected(pathname: string): boolean {
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(pathname));
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (!isProtected(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (hasValidSessionShape(token)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const signInUrl = new URL('/', request.url);
  signInUrl.searchParams.set('signin', 'required');
  signInUrl.searchParams.set('from', pathname);
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: ['/dashboard/:path*', '/api/user/:path*'],
};
