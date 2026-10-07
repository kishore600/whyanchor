import { NextResponse } from "next/server";

// Never cache: a health check that answers from a CDN says nothing about the running deploy.
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({
    status: "ok",
    service: "whyanchor-web",
    // Vercel exposes the deployed commit when "Automatically expose System Environment Variables" is on.
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "dev").slice(0, 7),
  });
}
