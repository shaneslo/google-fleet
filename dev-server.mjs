import { createServer } from "node:http";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createServer as createViteServer } from "vite";

const PORT = 3000;
const HOST = "0.0.0.0";
const ISSUER = "https://fleet-dev.cloudflareaccess.com";
const AUDIENCE = "fleet-dev-audience";
const JWKS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const DATABASE_ID = "7132d7a7-6b2b-4caf-8986-f91c2c3292dd";

const ACTORS = [
  { id: "shane", name: "Shane Slosar", kind: "human", sub: "synthetic-human-shane" },
  { id: "codex", name: "Codex", kind: "service", sub: "codex-synthetic.access" },
  { id: "claude", name: "Claude", kind: "service", sub: "claude-synthetic.access" },
  { id: "agentslo", name: "AgentSlo", kind: "service", sub: "agentslo-synthetic.access" },
  { id: "juniorslo", name: "JuniorSLO", kind: "service", sub: "juniorslo-synthetic.access" },
];

async function main() {
  if (!existsSync("dist")) {
    mkdirSync("dist", { recursive: true });
  }

  // 1. Bundle worker
  console.log("Building Worker bundle for local runtime...");
  await build({
    entryPoints: ["worker/src/index.ts"],
    outfile: "dist/worker.mjs",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    logLevel: "silent",
  });

  // 2. Generate local signing keys
  const keys = await generateKeyPair("RS256", { extractable: true });
  const publicKey = { ...(await exportJWK(keys.publicKey)), alg: "RS256", kid: "fleet-dev-key", use: "sig" };

  async function createToken(actorId) {
    const actor = ACTORS.find((a) => a.id === actorId) ?? ACTORS[0];
    const claims = actor.kind === "human"
      ? { sub: actor.sub, type: "app" }
      : { sub: "", common_name: actor.sub, type: "app" };

    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "fleet-dev-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setNotBefore(now - 5)
      .setExpirationTime(now + 7200)
      .sign(keys.privateKey);
  }

  // 3. Start Miniflare with D1
  console.log("Starting Miniflare with local D1 database...");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      host: "127.0.0.1",
      resourcePersistencePath: ".wrangler/state/v3",
      workers: [
        {
          name: "fleet",
          modules: true,
          scriptPath: "dist/worker.mjs",
          compatibilityDate: "2026-08-31",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { DB: DATABASE_ID },
          bindings: {
            FLEET_ACCESS_ISSUER: ISSUER,
            FLEET_ACCESS_AUDIENCE: AUDIENCE,
            FLEET_ACCESS_JWKS_URL: JWKS_URL,
          },
          outboundService: (request) => {
            if (request.url === JWKS_URL) {
              return Response.json({ keys: [publicKey] });
            }
            return new Response("Not found", { status: 404 });
          },
        },
      ],
    }),
  );

  const db = await mf.getD1Database("DB");

  // Enroll synthetic actors
  for (const a of ACTORS) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO actor_principals (provider, issuer, kind, subject, actor_id) VALUES ('cloudflare_access', ?, ?, ?, ?)",
      )
      .bind(ISSUER, a.kind, a.sub, a.id)
      .run();
  }

  // 4. Seed foundation project if database is empty
  const projectCount = await db.prepare("SELECT count(*) as count FROM projects").first();
  if (!projectCount || projectCount.count === 0) {
    console.log("Seeding Fleet V1 Foundation project into local database...");
    await seedFoundation(mf, createToken);
  }

  // 5. Initialize Vite in middleware mode
  console.log("Initializing Vite dev middleware...");
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: false },
    appType: "spa",
  });

  // 6. Start unified HTTP server
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost:3000"}`);

      // Handle seat switcher link
      if (url.pathname === "/api/seat") {
        const to = url.searchParams.get("to");
        if (to && ACTORS.some((a) => a.id === to)) {
          res.setHeader("Set-Cookie", `fleet_seat=${to}; Path=/; SameSite=Lax`);
        }
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }

      // Read current seat
      const seatParam = url.searchParams.get("seat");
      const cookieMatch = req.headers.cookie?.match(/(?:^|;\s*)fleet_seat=([a-z0-9_-]+)(?:;|$)/);
      let currentSeat = seatParam || (cookieMatch ? cookieMatch[1] : "shane");
      if (!ACTORS.some((a) => a.id === currentSeat)) currentSeat = "shane";

      // If seat was in query param, persist to cookie
      if (seatParam && ACTORS.some((a) => a.id === seatParam)) {
        res.setHeader("Set-Cookie", `fleet_seat=${seatParam}; Path=/; SameSite=Lax`);
      }

      // Handle Worker API
      if (url.pathname === "/health" || url.pathname.startsWith("/v1/")) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

        const token = await createToken(currentSeat);
        const origin = `http://${req.headers.host || "127.0.0.1:3000"}`;
        const headers = new Headers({
          "Cf-Access-Jwt-Assertion": token,
          Origin: req.headers.origin || origin,
        });

        for (const name of ["content-type", "idempotency-key", "if-match", "accept"]) {
          if (typeof req.headers[name] === "string") {
            headers.set(name, req.headers[name]);
          }
        }

        const dispatchUrl = `http://127.0.0.1${url.pathname}${url.search}`;
        const workerResponse = await mf.dispatchFetch(dispatchUrl, {
          method: req.method,
          headers,
          body,
        });

        res.writeHead(workerResponse.status, Object.fromEntries(workerResponse.headers));
        res.end(Buffer.from(await workerResponse.arrayBuffer()));
        return;
      }

      // Handle HTML pages - inject seat switcher banner
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const rawHtml = await vite.transformIndexHtml(url.pathname, await getIndexHtml());
        const bannerHtml = getBannerHtml(currentSeat);
        const injectedHtml = rawHtml.replace("<body>", `<body>\n${bannerHtml}`);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(injectedHtml);
        return;
      }

      // Fall through to Vite middleware
      vite.middlewares(req, res);
    } catch (err) {
      console.error("Server error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`✅ Fleet Board dev server ready on http://${HOST}:${PORT}`);
  });

  const cleanup = async () => {
    console.log("Shutting down dev server...");
    await vite.close();
    await mf.dispose();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

async function getIndexHtml() {
  const { readFile } = await import("node:fs/promises");
  return readFile("index.html", "utf-8");
}

function getBannerHtml(currentSeat) {
  const actor = ACTORS.find((a) => a.id === currentSeat) ?? ACTORS[0];
  const links = ACTORS.map(
    (a) =>
      `<a href="/api/seat?to=${a.id}" style="color:${a.id === currentSeat ? '#f59e0b' : '#94a3b8'};text-decoration:${a.id === currentSeat ? 'underline' : 'none'};font-weight:${a.id === currentSeat ? '700' : '400'};padding:2px 6px;border-radius:4px;background:${a.id === currentSeat ? '#1e293b' : 'transparent'}">${a.name}</a>`,
  ).join(" ");

  return `
  <aside style="background:#0f172a;color:#e2e8f0;padding:8px 16px;font-size:13px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;border-bottom:1px solid #334155;font-family:system-ui,-apple-system,sans-serif;">
    <div><strong>Fleet Identity:</strong> Viewing as <strong>${actor.name}</strong> (${actor.kind})</div>
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
      <span style="color:#94a3b8;font-size:12px;">Switch Seat:</span>
      ${links}
    </div>
  </aside>
  `;
}

async function seedFoundation(mf, createToken) {
  const call = async (actor, path, body, version, key = crypto.randomUUID()) => {
    const token = await createToken(actor);
    const headers = {
      "Cf-Access-Jwt-Assertion": token,
      Origin: "http://127.0.0.1",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = key;
    }
    if (version !== undefined) headers["If-Match"] = `"${version}"`;

    const res = await mf.dispatchFetch(`http://127.0.0.1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${actor} ${path} failed (${res.status}): ${text}`);
    return JSON.parse(text);
  };

  try {
    const project = await call("shane", "/v1/projects", {
      slug: "fleet-v1-foundation",
      title: "Fleet V1 Foundation",
      originator_id: "shane",
    });

    await call(
      "shane",
      `/v1/projects/${project.id}/authorize`,
      {
        proposed_owner_id: "codex",
        outcome:
          "Deliver a working Fleet V1 control plane that makes shared commitments legible without claiming to represent the whole life of an agent.",
        scope: [
          "Establish workslo/fleet canonical checkout",
          "Preserve signed agreement",
          "Define versioned domain/HTTP contracts",
          "Implement Worker, D1 schema, thin Board",
          "Bounded lanes for Claude, AgentSlo, JuniorSLO",
        ],
        exclusions: [
          "No Fleet EmDash code/data changes",
          "No Linear migration",
          "No unaccepted seats",
        ],
        delegated_actions: [
          "Bounded synthetic requests",
          "Native routine reconciliation",
        ],
        gates: [
          "Shane gate on production Cloudflare deployment",
          "Shane gate on new seat activation",
        ],
        validation_evidence: ["Local recovery report", "Passing test suite"],
        plan: "Export, restore, compare, and resume locally; native Routine reconciliation through Worker interface.",
      },
      1,
    );

    await call("codex", `/v1/projects/${project.id}/owner-accept`, {}, 2);

    const blocked = await call("juniorslo", `/v1/projects/${project.id}/requests`, {
      recipient_id: "codex",
      title: "Integrate Fleet Routine client with Worker interface",
      detail: "Bounded work request for the Fleet control plane implementation.",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await call("codex", `/v1/requests/${blocked.id}/accept`, {}, 1);
    await call("codex", `/v1/requests/${blocked.id}/block`, {
      reason: "Waiting for Shane approval on envelope gate",
      resolution_condition: "Decision recorded on Needs Shane",
    }, 2);

    const returned = await call("juniorslo", "/v1/requests", {
      recipient_id: "codex",
      title: "Review domain contracts against signed agreement",
      detail: "Check contracts/http-v1.md and authority-v1.md against working agreement.",
    });
    await call("codex", `/v1/requests/${returned.id}/accept`, {}, 1);
    await call(
      "codex",
      `/v1/requests/${returned.id}/return`,
      {
        reason: "Time limit on bounded execution",
        unfinished_work: "Review Section 13 pilot criteria",
        evidence: [
          {
            uri: "https://github.com/workslo/fleet/tree/main/contracts",
            summary: "Reviewed contracts/http-v1.md and authority-v1.md",
          },
        ],
      },
      2,
      "dev-seed-key-return",
    );

    const fulfilled = await call("juniorslo", `/v1/projects/${project.id}/requests`, {
      recipient_id: "codex",
      title: "Implement thin Fleet Board views",
      detail: "Deliver Portfolio, My Work, Decisions, and Pull Candidates views.",
    });
    await call("codex", `/v1/requests/${fulfilled.id}/accept`, {}, 1);
    await call(
      "codex",
      `/v1/requests/${fulfilled.id}/fulfill`,
      {
        evidence: [
          {
            uri: "https://github.com/workslo/fleet/tree/main/board",
            summary: "Portfolio, My Work, Decisions, and Pull Candidates views delivered",
          },
        ],
      },
      2,
    );

    await call("juniorslo", "/v1/requests", {
      recipient_id: "codex",
      title: "Verify local recovery export and restore runbook",
      detail: "Run local recovery rehearsal with --serve to confirm snapshot and restore.",
    });

    const pendingNeed = await call("codex", "/v1/decisions", {
      work_request_id: blocked.id,
      kind: "decision_and_action",
      question: "Approve envelope gate for Routine client integration",
      resolution_condition: "Confirmation received from Shane",
    });
    await call(
      "shane",
      `/v1/decisions/${pendingNeed.id}/decide`,
      {
        choice: "approved",
        summary: "Approved for local foundation envelope",
      },
      1,
    );

    const resolvedNeed = await call("codex", "/v1/decisions", {
      work_request_id: returned.id,
      kind: "action",
      question: "Record Section 13 review handback",
      resolution_condition: "Handback receipt documented",
    });
    await call(
      "shane",
      `/v1/decisions/${resolvedNeed.id}/delegate-action`,
      {
        delegate_id: "codex",
        summary: "Record Section 13 handback directly",
      },
      1,
    );
    await call(
      "codex",
      `/v1/decisions/${resolvedNeed.id}/complete-action`,
      {
        summary: "Handback recorded with evidence links",
        evidence: [
          {
            uri: "https://github.com/workslo/fleet/blob/main/governance/agreements/FLEET-WORKING-AGREEMENT-v1.0.md",
            summary: "Section 13 reviewed",
          },
        ],
      },
      2,
    );

    await call("codex", "/v1/pull-candidates", {
      project_id: project.id,
      title: "Automated test coverage for boundary checks",
      detail: "Additional edge cases identified for input boundary validation.",
    });

    console.log("✅ Seed completed successfully!");
  } catch (err) {
    console.warn("Notice: Seeding foundation data encountered an issue:", err.message);
  }
}

main().catch((err) => {
  console.error("Failed to start dev server:", err);
  process.exit(1);
});
