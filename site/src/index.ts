import promptMd from "./prompt.md?raw";
import { renderLandingPage } from "./page.js";

const landingHtml = renderLandingPage(promptMd);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
} as const;

function respondHtml(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=120, stale-while-revalidate=600",
    },
  });
}

function respondMarkdown(markdown: string): Response {
  return new Response(markdown, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/markdown; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": "application/json; charset=utf-8",
          Allow: "GET, HEAD",
        },
      });
    }

    if (pathname === "/" || pathname === "/index.html") {
      return respondHtml(landingHtml);
    }

    if (pathname === "/prompt.md") {
      return respondMarkdown(promptMd);
    }

    if (pathname === "/health") {
      return Response.json(
        { ok: true, service: "acrowly-site", domain: "acrowly.com" },
        {
          headers: {
            ...SECURITY_HEADERS,
            "Cache-Control": "no-store",
          },
        }
      );
    }

    console.log(
      JSON.stringify({
        level: "info",
        event: "not_found",
        method: request.method,
        path: pathname,
      })
    );

    return respondHtml(
      `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" /><title>404 · Acrowly</title></head><body style="background:#0b0d10;color:#eef2f6;font-family:sans-serif;padding:48px 24px;max-width:640px;margin:0 auto;"><h1>404</h1><p>页面不存在。返回 <a href="/" style="color:#f38020;">acrowly.com</a> 或查看 <a href="/prompt.md" style="color:#f38020;">/prompt.md</a>。</p></body></html>`,
      404
    );
  },
} satisfies ExportedHandler;
