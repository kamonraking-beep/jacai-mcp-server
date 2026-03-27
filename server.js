import fetch from "node-fetch";
import "dotenv/config";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 8787);
const BASE_URL =
  (process.env.JACAI_BASE_URL || "https://studio1live.com/ashley/smm/szam/social-media-manager").replace(/\/+$/, "");
const AUTH_BEARER = process.env.JACAI_BEARER_TOKEN || "";
const ENABLE_VERBOSE_LOGS = (process.env.MCP_VERBOSE_LOGS || "1") === "1";

function log(...args) {
  if (ENABLE_VERBOSE_LOGS) console.log(...args);
}

function jacaiUrl(path) {
  return `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

async function postJson(path, body) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (AUTH_BEARER) {
    headers["Authorization"] = `Bearer ${AUTH_BEARER}`;
  }

  const fullUrl = jacaiUrl(path);
  log("\n=== MCP TOOL CALL ===");
  log("URL:", fullUrl);
  log("BODY:", JSON.stringify(body, null, 2));

  const res = await fetch(fullUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  log("STATUS:", res.status);
  log("RAW RESPONSE:", text);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {
      ok: false,
      error: `Non-JSON response: ${text.slice(0, 1000)}`,
      raw_text: text,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: data?.error || `HTTP ${res.status}`,
      status: res.status,
      raw: data,
    };
  }

  return data;
}

function reply(result, message = "Done.") {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: result,
  };
}

function defaultDraftArgs(args = {}) {
  return {
    project_id: args.project_id ?? "default",
    site_profile_id: args.site_profile_id ?? 1,
    platform: args.platform ?? "instagram",
    content_type: args.content_type ?? "static_post",
    status: args.status ?? "draft",
    source_workflow_run_id: args.source_workflow_run_id ?? "default",
    ...args,
  };
}

function defaultQueueArgs(args = {}) {
  return {
    publish_target: args.publish_target ?? "instagram",
    approval_status: args.approval_status ?? "approved",
    channel: args.channel ?? "instagram",
    ...args,
  };
}

function defaultPublishArgs(args = {}) {
  return {
    site_section: args.site_section ?? "blog",
    publish_now: args.publish_now ?? true,
    ...args,
  };
}

function jsonSchemaToZodShape(schema = {}) {
  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const shape = {};

  for (const [k, v] of Object.entries(properties)) {
    let zType = z.string();

    if (v && typeof v === "object") {
      if (v.type === "number" || v.type === "integer") zType = z.number();
      else if (v.type === "boolean") zType = z.boolean();
      else if (v.type === "array") {
        const itemType = v.items?.type;
        if (itemType === "number" || itemType === "integer") zType = z.array(z.number());
        else if (itemType === "boolean") zType = z.array(z.boolean());
        else zType = z.array(z.string());
      } else {
        zType = z.string();
      }
    }

    if (!required.includes(k)) {
      zType = zType.optional();
    }

    shape[k] = zType;
  }

  return shape;
}

function shouldSkipAutoTool(tool) {
  const key = tool?.key || "";
  const type = tool?.type || "";

  if (!tool?.enabled) return true;

  // Keep these manual, because they have custom behavior/defaults.
  const manualTools = new Set([
    "save_content_draft",
    "generate_visual_brief",
    "attach_asset_to_draft",
    "generate_video_asset",
    "queue_for_publish",
    "publish_to_static_site",
  ]);
  if (manualTools.has(key)) return true;

  // Skip internal writer tools; agent builder already handles model writing.
  if (["openai_writer", "openai_draft"].includes(key)) return true;

  // Allow builtin/http/openai-like tools; skip unknown app-internal types unless you want them.
  const allowedTypes = new Set(["http", "builtin", "openai", "openai_chat", "tagx"]);
  if (!allowedTypes.has(type)) return true;

  return false;
}

async function loadJacaiTools(server) {
  try {
    const toolsUrl = `${BASE_URL}/api/tools.php?action=list`;
    console.log("Loading tools from:", toolsUrl);

    const res = await fetch(toolsUrl);
    console.log("Tools list HTTP status:", res.status);

    const text = await res.text();
    console.log("Tools list raw response:", text.slice(0, 2000));

    const data = JSON.parse(text);

    if (!data.ok || !Array.isArray(data.items)) {
      console.error("Failed to load tools list: invalid payload");
      return;
    }

    console.log(`Found ${data.items.length} tools in SMM registry`);

    for (const tool of data.items) {
      console.log("Considering tool:", tool.key, "type:", tool.type, "enabled:", tool.enabled);

      if (shouldSkipAutoTool(tool)) {
        console.log("Skipping tool:", tool.key);
        continue;
      }

      const key = tool.key;

      try {
        let schema = {};
        try {
          schema = JSON.parse(tool.config_json || "{}");
        } catch (e) {
          console.error(`Could not parse config_json for ${key}:`, e.message);
          schema = {};
        }

        const zodShape = jsonSchemaToZodShape(schema);

        server.registerTool(
          key,
          {
            title: tool.name || key,
            description: `${tool.name || key} (auto-loaded from SMM)`,
            inputSchema: zodShape,
          },
          async (args) => {
            const endpoint = `/api/tool_${key}.php`;
            const result = await postJson(endpoint, args);

            const msg = result.ok
              ? `${key} executed successfully.`
              : `${key} failed: ${result.error || "Unknown error"}`;

            return reply(result, msg);
          }
        );

        console.log(`Auto-loaded tool: ${key}`);
      } catch (err) {
        console.error(`Failed to auto-register tool ${key}`, err);
      }
    }
  } catch (err) {
    console.error("loadJacaiTools fatal error:", err);
  }
}
async function createJacaiServer() {
  const server = new McpServer({
    name: "jacai-smm",
    version: "2.0.0",
  });

  // ---------------------------------------------------------------------------
  // MANUAL TOOLS WITH CUSTOM DEFAULTS / BEHAVIOR
  // ---------------------------------------------------------------------------

  server.registerTool(
    "save_content_draft",
    {
      title: "Save Content Draft",
      description: "Save generated social media content into Jacai as a draft.",
      inputSchema: {
        project_id: z.string().optional(),
        site_profile_id: z.number().int().optional(),
        platform: z.string().optional(),
        content_type: z.string().optional(),
        title: z.string(),
        caption: z.string(),
        hashtags: z.array(z.string()).optional(),
        image_prompt: z.string().optional(),
        video_brief: z.string().optional(),
        cta: z.string().optional(),
        slug: z.string().optional(),
        status: z.string().optional(),
        source_workflow_run_id: z.string().optional(),
        featured_image: z.string().optional(),
        featured_video: z.string().optional(),
        image_assets: z.array(z.string()).optional(),
        video_assets: z.array(z.string()).optional(),
        asset_urls: z.array(z.string()).optional(),
        excerpt: z.string().optional(),
        brand_profile: z.string().optional(),
        post_goal: z.string().optional(),
        visual_style: z.string().optional(),
        publish_target: z.string().optional(),
        channel: z.string().optional(),
      },
    },
    async (args) => {
      const payload = defaultDraftArgs(args);
      const result = await postJson("/api/tool_save_content_draft.php", payload);

      const msg = result.ok
        ? `Draft saved with ID ${result.draft_id}.`
        : `Failed to save draft: ${result.error || "Unknown error"}`;

      return reply(result, msg);
    }
  );

  server.registerTool(
    "generate_visual_brief",
    {
      title: "Generate Visual Brief",
      description: "Create image prompts, shot lists, thumbnail ideas, and video direction for a social post.",
      inputSchema: {
        platform: z.string(),
        brand_profile: z.string(),
        post_goal: z.string(),
        caption_or_topic: z.string(),
        visual_style: z.string().optional(),
        asset_mode: z.enum(["image", "video", "both"]).default("both"),
      },
    },
    async (args) => {
      const result = await postJson("/api/tool_generate_visual_brief.php", args);

      const msg = result.ok
        ? "Visual brief generated."
        : `Failed to generate visual brief: ${result.error || "Unknown error"}`;

      return reply(result, msg);
    }
  );

  server.registerTool(
    "attach_asset_to_draft",
    {
      title: "Attach Asset To Draft",
      description: "Attach generated image/video assets or asset URLs to an existing Jacai draft.",
      inputSchema: {
        draft_id: z.number().int(),
        featured_image: z.string().optional(),
        featured_video: z.string().optional(),
        image_prompt: z.string().optional(),
        video_brief: z.string().optional(),
        image_assets: z.array(z.string()).optional(),
        video_assets: z.array(z.string()).optional(),
        asset_urls: z.array(z.string()).optional(),
        asset_label: z.string().optional(),
        asset_type: z.string().optional(),
        updated_by: z.string().optional(),
      },
    },
    async (args) => {
      const result = await postJson("/api/tool_attach_asset_to_draft.php", {
        updated_by: "asset_agent",
        ...args,
      });

      const msg = result.ok
        ? `Assets attached to draft ${result.draft_id}.`
        : `Failed to attach assets: ${result.error || "Unknown error"}`;

      return reply(result, msg);
    }
  );

  server.registerTool(
    "generate_video_asset",
    {
      title: "Generate Video Asset",
      description: "Generate a video asset using Jacai's internal video API wrapper.",
      inputSchema: {
        prompt: z.string(),
        style: z.string().optional(),
        duration_seconds: z.number().int().optional(),
        aspect_ratio: z.string().optional(),
        draft_id: z.number().int().optional(),
      },
    },
    async (args) => {
      const result = await postJson("/api/tool_generate_video_asset.php", args);

      const msg = result.ok
        ? "Video asset generated."
        : `Failed to generate video asset: ${result.error || "Unknown error"}`;

      return reply(result, msg);
    }
  );

  server.registerTool(
    "queue_for_publish",
    {
      title: "Queue For Publish",
      description: "Queue an approved Jacai draft for publishing.",
      inputSchema: {
        draft_id: z.number().int(),
        publish_target: z.string().optional(),
        publish_at: z.string().optional(),
        approval_status: z.string().optional(),
        channel: z.string().optional(),
      },
    },
    async (args) => {
      const payload = defaultQueueArgs(args);
      const result = await postJson("/api/tool_queue_for_publish.php", payload);

      const msg = result.ok
        ? `Draft queued${result.scheduled_for ? ` for ${result.scheduled_for}` : ""}.`
        : `Failed to queue draft: ${result.error || "Unknown error"}`;

      return reply(result, msg);
    }
  );

  server.registerTool(
    "publish_to_static_site",
    {
      title: "Publish To Static Site",
      description: "Publish an approved Jacai draft to the static site.",
      inputSchema: {
        draft_id: z.number().int(),
        site_section: z.string().optional(),
        slug: z.string().optional(),
        seo_title: z.string().optional(),
        seo_description: z.string().optional(),
        featured_image: z.string().optional(),
        publish_now: z.boolean().optional(),
      },
    },
    async (args) => {
      const payload = defaultPublishArgs(args);
      const result = await postJson("/api/tool_publish_to_static_site.php", payload);

      const msg = result.ok
        ? `Published to ${result.url || "static site"}.`
        : `Failed to publish: ${result.error || "Unknown error"}`;

      return reply(result, msg);
    }
  );

  // ---------------------------------------------------------------------------
  // AUTO-LOAD REMAINING SMM TOOLS
  // ---------------------------------------------------------------------------
  await loadJacaiTools(server);

  return server;
}

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "jacai-mcp",
          version: "2.0.0",
          endpoints: {
            health: "/health",
            mcp: "/mcp",
          },
        })
      );
      return;
    }

   if (url.pathname === "/health") {
  try {
    const toolsUrl = `${BASE_URL}/api/tools.php?action=list`;
    const toolsRes = await fetch(toolsUrl);
    const text = await toolsRes.text();

    let parsed = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { ok: false, raw: text };
    }

    const toolKeys = Array.isArray(parsed.items)
      ? parsed.items.map(t => ({
          key: t.key,
          type: t.type,
          enabled: t.enabled
        }))
      : [];

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "jacai-mcp",
        version: "2.0.0",
        base_url: BASE_URL,
        tools_found: toolKeys.length,
        tools: toolKeys
      })
    );
    return;
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : "health failed"
      })
    );
    return;
  }
}

    const server = await createJacaiServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("MCP server error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : "Internal server error",
      })
    );
  }
});

httpServer.listen(PORT, () => {
  console.log(`Jacai MCP server listening on http://localhost:${PORT}/mcp`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Base URL: ${BASE_URL}`);
});