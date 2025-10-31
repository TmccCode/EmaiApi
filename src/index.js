import PostalMime from "postal-mime";

export default {
  //
  // ====================== 邮件接收入口 ======================
  //
  async email(message, env, ctx) {
    const FALLBACK_GMAIL = "ztjs999999@gmail.com";
    const now = () => Date.now();

    try {
      // 1) 邮件解析
      const parser = new PostalMime();
      const parsed = await parser.parse(message.raw);

      const from = parsed.from?.address || (message.from ?? message.headers.get("from") ?? "");
      const toEmail = (parsed.to?.[0]?.address || "").toLowerCase();
      const subject = parsed.subject || (message.headers.get("subject") ?? "");
      const textBody = (parsed.text || "").trim();
      const htmlBody = (parsed.html || "").trim();
      const bodyText = (textBody || htmlBody || "(空内容)").slice(0, 200_000);
      const messageId = parsed.messageId || (message.headers.get("message-id") || null);
      const createdAt = now();

      // 2) 拆出 local_part + domain
      let localPart = "", domain = "";
      if (toEmail.includes("@")) {
        [localPart, domain] = toEmail.split("@");
        localPart = localPart.toLowerCase();
        domain = domain.toLowerCase();
      }

      // 3) 写入数据库（status 固定 o1）
      try {
        await env.EmailSql.prepare(
          `INSERT INTO email_inbox
           (domain, local_part, to_email, from_email, subject, body_text, status, created_at, message_id)
           VALUES (?, ?, ?, ?, ?, ?, 'o1', ?, ?)`
        )
        .bind(domain, localPart, toEmail, from, subject, bodyText, createdAt, messageId)
        .run();
        console.log("✅ 收件入库成功:", toEmail, subject);
      } catch (e) {
        const msg = String(e?.message || e);
        if (!msg.includes("idx_inbox_msgid")) {
          console.error("DB insert error:", msg);
        }
      }

      // 4) 查 mailboxes 表
      let needForward = false;
      try {
        const mb = await env.EmailSql
          .prepare("SELECT status FROM mailboxes WHERE domain=? AND local_part=? LIMIT 1")
          .bind(domain, localPart)
          .first();
        if (!mb || mb.status !== "active") {
          needForward = true;
          console.log("📤 未登记或禁用，转发至 Gmail:", toEmail);
        }
      } catch (e) {
        needForward = true;
        console.error("查 mailboxes 失败:", e);
      }

      // 5) 异步转发
      if (needForward) {
        ctx.waitUntil(
          (async () => {
            try {
              await message.forward(FALLBACK_GMAIL);
              console.log("📩 已转发到:", FALLBACK_GMAIL);
            } catch (err) {
              console.error("转发失败:", String(err?.message || err));
            }
          })()
        );
      }
    } catch (err) {
      console.error("PostalMime 解析失败:", String(err?.message || err));
      ctx.waitUntil(message.forward("ztjs999999@gmail.com"));
    }

    return new Response("ok", { status: 200 });
  },

  //
  // ====================== HTTP 接口 ======================
  //
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const baseHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };

    // ✅ 允许 CORS 预检
    if (method === "OPTIONS") {
      return new Response("OK", {
        headers: {
          ...baseHeaders,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Secret",
        },
      });
    }

    // 工具：从 URL 或 Header 中提取密钥
    const getKey = () => {
      const qk = url.searchParams.get("key");
      if (qk) return qk;
      const auth = request.headers.get("authorization") || "";
      if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7);
      const xs = request.headers.get("x-secret");
      if (xs) return xs;
      return null;
    };

    try {
      // ---------- 1. 查询收件箱（GET） ----------
      if (path === "/inbox" && method === "GET") {
        const key = getKey();
        if (!key) return json({ ok: false, msg: "缺少密钥" }, baseHeaders);

        const page = Math.max(parseInt(url.searchParams.get("page") || "1", 10), 1);
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "10", 10), 1), 50);
        const status = (url.searchParams.get("status") || "o1").toLowerCase();

        // 查 mailbox
        const box = await env.EmailSql
          .prepare("SELECT domain, local_part FROM mailboxes WHERE secret=? LIMIT 1")
          .bind(key)
          .first();
        if (!box) return json({ ok: false, msg: "密钥无效" }, baseHeaders);

        const offset = (page - 1) * limit;

        const mails = await env.EmailSql
          .prepare(
            `SELECT id, from_email, subject, body_text, created_at
             FROM email_inbox
             WHERE domain=? AND local_part=? AND status=?
             ORDER BY created_at DESC LIMIT ? OFFSET ?`
          )
          .bind(box.domain, box.local_part, status, limit, offset)
          .all();

        const totalRow = await env.EmailSql
          .prepare(
            `SELECT COUNT(*) AS total FROM email_inbox
             WHERE domain=? AND local_part=? AND status=?`
          )
          .bind(box.domain, box.local_part, status)
          .first();

        const email = `${box.local_part}@${box.domain}`;
        return json({
          ok: true,
          msg: "查询成功",
          email,
          page,
          limit,
          total: totalRow?.total || 0,
          list: mails.results || [],
        }, baseHeaders);
      }

      // ---------- 2. 删除邮件 ----------
      if (path === "/delete" && method === "POST") {
        const { key, id } = await request.json();
        if (!key || !id) return json({ ok: false, msg: "缺少参数" }, baseHeaders);

        const box = await env.EmailSql
          .prepare("SELECT domain, local_part FROM mailboxes WHERE secret=? LIMIT 1")
          .bind(key)
          .first();
        if (!box) return json({ ok: false, msg: "密钥无效" }, baseHeaders);

        await env.EmailSql
          .prepare("UPDATE email_inbox SET status='o2' WHERE id=? AND domain=? AND local_part=?")
          .bind(id, box.domain, box.local_part)
          .run();

        return json({ ok: true, msg: "邮件已删除" }, baseHeaders);
      }

      // ---------- 3. 创建密钥 ----------
      if (path === "/create" && method === "POST") {
        const { email } = await request.json();
        if (!email || !email.includes("@"))
          return json({ ok: false, msg: "邮箱格式错误" }, baseHeaders);

        const [local_part, domain] = email.toLowerCase().split("@");
        const secret = randomKey(16);
        const ts = Date.now();

        await env.EmailSql
          .prepare(
            "INSERT INTO mailboxes (domain, local_part, secret, status, created_at) VALUES (?, ?, ?, 'active', ?)"
          )
          .bind(domain, local_part, secret, ts)
          .run();

        return json({ ok: true, msg: "创建成功", key: secret }, baseHeaders);
      }

      return json({ ok: false, msg: "Not Found" }, baseHeaders);
    } catch (e) {
      return json({ ok: false, msg: e.message || String(e) }, baseHeaders, 500);
    }
  },
};

// ========= 工具函数 =========
function randomKey(len = 16) {
  const chars = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
  let str = "";
  for (let i = 0; i < len; i++) str += chars.charAt(Math.floor(Math.random() * chars.length));
  return str;
}

function json(obj, headers, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers });
}
