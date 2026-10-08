import type { MetadataRoute } from "next";

/**
 * Every fetch of a week, case or per-plan receipts URL is a billed Blob read (Vercel Hobby: 10,000 simple ops a month,
 * 30-day lockout past it), and /integrations/qloo links every listed week. Crawlers keep the three public landing pages.
 * a2a r03: no root `Allow: /` — first-match parsers (Python urllib.robotparser before 3.13) let it override every Disallow;
 * a path with no matching rule is allowed anyway.
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/cases/new", disallow: ["/plans/", "/cases/", "/api/", "/integrations/qloo?"] }] };
}
