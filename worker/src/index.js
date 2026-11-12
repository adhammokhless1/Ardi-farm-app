// أرضي AI server: keeps the Claude API key secret and only answers
// agriculture requests from the Ardi app.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const MAX_PROMPT_CHARS = 40000;
const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 5_500_000; // about 4 MB per photo
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const SYSTEM = `أنت "طبيب الزرع" داخل تطبيق أرضي: مهندس زراعي مصري خبير.
بتساعد صغار ومتوسطي المزارعين في مصر في: تشخيص مشاكل النبات والتربة من الصور، برامج الري والتسميد والرش، وقراءة الجو.
ارفض بلطف أي طلب مش عن الزراعة أو التربة أو المياه أو الجو للزراعة.
الأمان: اذكر المادة الفعالة مش أسماء تجارية، والجرعة "حسب العبوة"، وفترة الأمان، وانصح بالمبيدات المسجلة في مصر بس.
رد دايماً بكائن JSON واحد صحيح بالشكل المطلوب في الرسالة، من غير أي كلام قبله أو بعده، ومن غير \`\`\`.`;

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    },
  };
}

function reply(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}

function parseJson(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const c = cors(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: c.ok ? 204 : 403, headers: c.headers });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return reply({ ok: true, key: !!env.ANTHROPIC_API_KEY }, 200, c.headers);
    if (request.method !== "POST" || url.pathname !== "/ai") return reply({ error: "not_found" }, 404, c.headers);
    if (!c.ok) return reply({ error: "origin_not_allowed" }, 403, c.headers);
    if (!env.ANTHROPIC_API_KEY) return reply({ error: "not_configured" }, 503, c.headers);

    let body;
    try { body = await request.json(); } catch { return reply({ error: "bad_request" }, 400, c.headers); }
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt || prompt.length > MAX_PROMPT_CHARS) return reply({ error: "bad_prompt" }, 400, c.headers);
    const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
    for (const im of images) {
      if (!im || !IMAGE_TYPES.includes(im.media_type) || typeof im.data !== "string" || im.data.length > MAX_IMAGE_B64)
        return reply({ error: "image_rejected" }, 400, c.headers);
    }
    const effort = ["low", "medium", "high"].includes(body.effort) ? body.effort : "medium";

    const content = [
      ...images.map(im => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })),
      { type: "text", text: prompt },
    ];

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const msg = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        output_config: { effort },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content }],
      });
      if (msg.stop_reason === "refusal") return reply({ error: "refused" }, 200, c.headers);
      const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
      const json = parseJson(text);
      if (!json) return reply({ error: msg.stop_reason === "max_tokens" ? "too_long" : "invalid_json" }, 502, c.headers);
      return reply({ ok: true, json, model: msg.model, usage: { in: msg.usage.input_tokens, out: msg.usage.output_tokens } }, 200, c.headers);
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) return reply({ error: "rate_limited" }, 429, c.headers);
      if (err instanceof Anthropic.AuthenticationError) return reply({ error: "bad_key" }, 503, c.headers);
      if (err instanceof Anthropic.BadRequestError) return reply({ error: "bad_request", detail: String(err.message).slice(0, 300) }, 400, c.headers);
      if (err instanceof Anthropic.APIError) return reply({ error: "upstream", status: err.status }, 502, c.headers);
      return reply({ error: "network" }, 502, c.headers);
    }
  },
};
