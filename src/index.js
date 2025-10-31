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
  // ====================== HTTP 接口区 ======================
  //
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const baseHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };

    // CORS 预检
    if (method === "OPTIONS") {
      return new Response("OK", {
        headers: {
          ...baseHeaders,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    try {
      // ---------- 1. 验证密钥 ----------
      if (path === "/verify" && method === "POST") {
        const { key } = await request.json();
        if (!key) return json({ ok: false, msg: "缺少密钥" }, baseHeaders);

        const res = await env.EmailSql
          .prepare("SELECT domain, local_part, status FROM mailboxes WHERE secret=? LIMIT 1")
          .bind(key)
          .first();
        if (!res) return json({ ok: false, msg: "密钥无效" }, baseHeaders);
        if (res.status !== "active") return json({ ok: false, msg: "密钥已失效" }, baseHeaders);

        const email = `${res.local_part}@${res.domain}`;
        return json({ ok: true, msg: "验证成功", email }, baseHeaders);
      }

      // ---------- 2. 查询收件箱（分页） ----------
      if (path === "/inbox" && method === "POST") {
        const { key, page = 1, limit = 10 } = await request.json();
        if (!key) return json({ ok: false, msg: "缺少密钥" }, baseHeaders);

        const box = await env.EmailSql
          .prepare("SELECT domain, local_part FROM mailboxes WHERE secret=? LIMIT 1")
          .bind(key)
          .first();
        if (!box) return json({ ok: false, msg: "密钥无效" }, baseHeaders);

        const offset = (page - 1) * limit;
        const mails = await env.EmailSql
          .prepare(
            "SELECT id, from_email, subject, body_text, created_at FROM email_inbox WHERE domain=? AND local_part=? AND status='o1' ORDER BY created_at DESC LIMIT ? OFFSET ?"
          )
          .bind(box.domain, box.local_part, limit, offset)
          .all();

        return json({ ok: true, list: mails.results }, baseHeaders);
      }

      // ---------- 3. 删除邮件（改状态） ----------
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

        return json({ ok: true, msg: "邮件已隐藏" }, baseHeaders);
      }

      // ---------- 4. 创建新密钥 ----------
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

      return json({ ok: false, msg: "Not Found" }, { status: 404, ...baseHeaders });
    } catch (e) {
      return json({ ok: false, msg: e.message || String(e) }, baseHeaders);
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
