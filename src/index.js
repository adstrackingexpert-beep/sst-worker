const HOME = `<!doctype html><html lang="bn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tracking Server Active</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#fff;text-align:center;padding:80px 20px}
a{color:#f6821f}</style></head><body>
<h1>✅ আপনার Tracking Server চালু আছে</h1>
<p>GTM ফাইল ডাউনলোড করুন: <a href="/gtm.json" download="gtm.json">/gtm.json</a></p>
<p>GTM → Admin → Import Container → Merge → Publish</p>
</body></html>`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_DOMAIN || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const isAllowed =
      allowed.length === 0 ||
      allowed.some((d) => origin === `https://${d}` || origin === `https://www.${d}`);
    const cors = {
      "Access-Control-Allow-Origin": isAllowed ? origin || "*" : "null",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(HOME, { headers: { "Content-Type": "text/html;charset=utf-8" } });
    }

    if (url.pathname === "/gtm.json") {
      return new Response(JSON.stringify(buildGtm(url.origin)), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/collect" && request.method === "POST") {
      if (!isAllowed) return new Response("Forbidden", { status: 403, headers: cors });
      const e = await request.json();
      const results = await Promise.allSettled([
        sendMeta(e, env, request),
        sendTikTok(e, env, request),
        sendGA4(e, env),
      ]);
      return new Response(JSON.stringify(results.map((r) => r.status)), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404, headers: cors });
  },
};

async function sha256(v) {
  if (!v) return undefined;
  const d = new TextEncoder().encode(String(v).trim().toLowerCase());
  const h = await crypto.subtle.digest("SHA-256", d);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendMeta(e, env, req) {
  if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN) return;
  const body = {
    data: [
      {
        event_name: e.event_name,
        event_time: Math.floor(Date.now() / 1000),
        event_id: e.event_id,
        event_source_url: e.url,
        action_source: "website",
        user_data: {
          em: e.email ? [await sha256(e.email)] : undefined,
          ph: e.phone ? [await sha256(e.phone)] : undefined,
          client_ip_address: req.headers.get("CF-Connecting-IP"),
          client_user_agent: req.headers.get("User-Agent"),
          fbp: e.fbp,
          fbc: e.fbc,
        },
        custom_data: {
          value: e.value,
          currency: e.currency || "BDT",
          content_ids: e.content_ids,
        },
      },
    ],
    ...(env.META_TEST_EVENT_CODE ? { test_event_code: env.META_TEST_EVENT_CODE } : {}),
  };
  const r = await fetch(
    `https://graph.facebook.com/v19.0/${env.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!r.ok) throw new Error(await r.text());
}

async function sendTikTok(e, env, req) {
  if (!env.TIKTOK_PIXEL_ID || !env.TIKTOK_ACCESS_TOKEN) return;
  const map = {
    Purchase: "CompletePayment",
    AddToCart: "AddToCart",
    ViewContent: "ViewContent",
    InitiateCheckout: "InitiateCheckout",
    PageView: "Pageview",
  };
  const body = {
    event_source: "web",
    event_source_id: env.TIKTOK_PIXEL_ID,
    ...(env.TIKTOK_TEST_EVENT_CODE ? { test_event_code: env.TIKTOK_TEST_EVENT_CODE } : {}),
    data: [
      {
        event: map[e.event_name] || e.event_name,
        event_time: Math.floor(Date.now() / 1000),
        event_id: e.event_id,
        user: {
          email: e.email ? await sha256(e.email) : undefined,
          phone: e.phone ? await sha256(e.phone) : undefined,
          ip: req.headers.get("CF-Connecting-IP"),
          user_agent: req.headers.get("User-Agent"),
          ttclid: e.ttclid,
        },
        page: { url: e.url },
        properties: { value: e.value, currency: e.currency || "BDT" },
      },
    ],
  };
  const r = await fetch("https://business-api.tiktok.com/open_api/v1.3/event/track/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Access-Token": env.TIKTOK_ACCESS_TOKEN },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
}

async function sendGA4(e, env) {
  if (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET) return;
  const names = {
    PageView: "page_view",
    ViewContent: "view_item",
    AddToCart: "add_to_cart",
    InitiateCheckout: "begin_checkout",
    Purchase: "purchase",
  };
  const r = await fetch(
    `https://www.google-analytics.com/mp/collect?measurement_id=${env.GA4_MEASUREMENT_ID}&api_secret=${env.GA4_API_SECRET}`,
    {
      method: "POST",
      body: JSON.stringify({
        client_id: e.client_id || e.event_id,
        events: [
          {
            name: names[e.event_name] || e.event_name,
            params: {
              value: e.value,
              currency: e.currency || "BDT",
              transaction_id: e.event_id,
            },
          },
        ],
      }),
    }
  );
  if (!r.ok) throw new Error(await r.text());
}

function buildGtm(origin) {
  const events = ["PageView", "ViewContent", "AddToCart", "InitiateCheckout", "Purchase"];
  const tags = events.map((name, i) => ({
    accountId: "0",
    containerId: "0",
    tagId: String(i + 1),
    name: `SST - ${name}`,
    type: "html",
    parameter: [
      {
        type: "TEMPLATE",
        key: "html",
        value:
          `<script>(function(){var c=function(v){return v&&v!=="undefined"?v:undefined};` +
          `var id=c("{{Event ID}}")||String(Date.now())+Math.random().toString(36).slice(2,8);` +
          `fetch("${origin}/collect",{method:"POST",keepalive:true,headers:{"Content-Type":"application/json"},` +
          `body:JSON.stringify({event_name:"${name}",event_id:id,url:location.href,` +
          `value:parseFloat(c("{{DLV - value}}"))||undefined,currency:c("{{DLV - currency}}"),` +
          `email:c("{{DLV - email}}"),phone:c("{{DLV - phone}}")})});})();</script>`,
      },
      { type: "BOOLEAN", key: "supportDocumentWrite", value: "false" },
    ],
    firingTriggerId: [String(100 + i)],
    tagFiringOption: "ONCE_PER_EVENT",
  }));
  const triggers = events.map((name, i) => ({
    accountId: "0",
    containerId: "0",
    triggerId: String(100 + i),
    name: `CE - ${name}`,
    type: "CUSTOM_EVENT",
    customEventFilter: [
      {
        type: "EQUALS",
        parameter: [
          { type: "TEMPLATE", key: "arg0", value: "{{_event}}" },
          { type: "TEMPLATE", key: "arg1", value: name },
        ],
      },
    ],
  }));
  const dlv = (n, k, id) => ({
    accountId: "0",
    containerId: "0",
    variableId: String(id),
    name: n,
    type: "v",
    parameter: [
      { type: "INTEGER", key: "dataLayerVersion", value: "2" },
      { type: "TEMPLATE", key: "name", value: k },
    ],
  });
  return {
    exportFormatVersion: 2,
    containerVersion: {
      container: { name: "SST Auto", usageContext: ["WEB"] },
      tag: tags,
      trigger: triggers,
      variable: [
        dlv("Event ID", "event_id", 200),
        dlv("DLV - value", "value", 201),
        dlv("DLV - currency", "currency", 202),
        dlv("DLV - email", "email", 203),
        dlv("DLV - phone", "phone", 204),
      ],
    },
  };
}
