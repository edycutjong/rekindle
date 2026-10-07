import { NextResponse, type NextRequest } from "next/server";

/**
 * Judge entry: `/?judge=<token>` from the Devpost testing instructions sets an
 * httpOnly cookie and redirects to the same page without the token, so judges get their own quota (lib/ratelimit.ts)
 * and are never counted against the public daily cap. A wrong token is silently ignored (public namespace).
 */
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function middleware(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("judge");
  if (token === null) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.searchParams.delete("judge");
  const res = NextResponse.redirect(url);
  const expected = process.env.JUDGE_TOKEN ?? "";
  if (expected.length >= 16 && same(token, expected)) {
    res.cookies.set("rk_judge", token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 60 });
  }
  return res;
}

export const config = { matcher: ["/((?!api|_next|favicon.svg|icon.svg|og-image.png).*)"] };
