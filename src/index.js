import PostalMime from "postal-mime";

export default {
  // ============================================================
  // ✉️ 邮件接收逻辑
  // ============================================================
  async email(message, env, ctx) {
    const FALLBACK_GMAIL = "ztjs999999@gmail.com";
    const now = () => Date.now();

    try {
      const parser = new PostalMime();
      const parsed = await parser.parse(message.raw);

      const from = parsed.from?.address || message.from || message.headers.get("from") || "";
      const toEmail = (parsed.to?.[0]?.address || "").toLowerCase();
      const subject = parsed.subject || message.headers.get("subject") || "";
      const bodyText = (parsed.text || parsed.html || "(空内容)").slice(0, 200000);
      const messageId = parsed.messageId || message.headers.get("message-id") || null;
      const createdAt = now();

      // 拆分邮箱
      let [localPart, domain] = ["", ""];
      if (toEmail.includes("@")) {
        [localPart, domain] = toEmail.split("@");
        localPart = localPart.toLowerCase();
        domain = domain.toLowerCase();
      }

      // 写入数据库
      try {
        await env.EmailSql.prepare(
          `INSERT INTO email_inbox
           (domain, local_part, to_email, from_email, subject, body_text, status, created_at, message_id)
           VALUES (?, ?, ?, ?, ?, ?, 'o1', ?, ?)`
        )
          .bind(domain, localPart, toEmail, from, subject, bodyText, createdAt, messageId)
          .run();
        console.log("📥 邮件已写入数据库:", toEmail, subject);
      } catch (e) {
        if (String(e.message).includes("idx_inbox_msgid")) {
          console.warn("⚠️ 重复邮件跳过:", messageId);
        } else {
          console.error("❌ 写入数据库失败:", e.message);
        }
      }

      // 判断是否转发
      let needForward = false;
      try {
        const mb = await env.EmailSql
          .prepare("SELECT status FROM mailboxes WHERE domain=? AND local_part=? LIMIT 1")
          .bind(domain, localPart)
          .first();
        if (!mb || mb.status !== "active") {
          needForward = true;
          console.log("📤 转发到 Gmail：", toEmail);
        }
      } catch (e) {
        needForward = true;
        console.error("mailboxes 查询异常:", e.message);
      }

      if (needForward) {
        ctx.waitUntil(message.forward(FALLBACK_GMAIL));
      }
    } catch (err) {
      console.error("postal-mime 解析失败:", err.message);
      ctx.waitUntil(message.forward("ztjs999999@gmail.com"));
    }

    return new Response("ok", { status: 200 });
  },

  // ============================================================
  // 🌐 HTTP API 接口
  // ============================================================
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // CORS 处理
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    const baseHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };

    try {
      // ---------------------------
      // 验证密钥
      // ---------------------------
      if (path === '/verify' && method === 'POST') {
				const { key } = await request.json();
				if (!key) return json({ ok: false, msg: '缺少密钥' }, baseHeaders);

				// ✅ 改这里
				const res = await env.EmailSql.prepare('SELECT domain, local_part, status FROM mailboxes WHERE secret=? LIMIT 1').bind(key).first();

				if (!res) return json({ ok: false, msg: '密钥无效' }, baseHeaders);
				if (res.status !== 'active') return json({ ok: false, msg: '密钥已失效' }, baseHeaders);

				// ✅ 拼接邮箱地址
				const email = `${res.local_part}@${res.domain}`;
				return json({ ok: true, msg: '验证成功', email }, baseHeaders);
			}


      // ---------------------------
      // 查询收件箱（分页）
      // ---------------------------
      if (path === "/inbox" && method === "POST") {
        const { key, page = 1, limit = 10 } = await request.json();
        if (!key) return json({ ok: false, msg: "缺少密钥" }, baseHeaders);

        const box = await env.EmailSql
          .prepare("SELECT email, domain, local_part FROM mailboxes WHERE secret_key=? LIMIT 1")
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

      // ---------------------------
      // 删除邮件（逻辑删除）
      // ---------------------------
      if (path === "/delete" && method === "POST") {
        const { key, id } = await request.json();
        if (!key || !id)
          return json({ ok: false, msg: "缺少参数" }, baseHeaders);

        const box = await env.EmailSql
          .prepare("SELECT domain, local_part FROM mailboxes WHERE secret_key=? LIMIT 1")
          .bind(key)
          .first();
        if (!box) return json({ ok: false, msg: "密钥无效" }, baseHeaders);

        await env.EmailSql
          .prepare("UPDATE email_inbox SET status='o2' WHERE id=? AND domain=? AND local_part=?")
          .bind(id, box.domain, box.local_part)
          .run();

        return json({ ok: true, msg: "邮件已删除" }, baseHeaders);
      }

      // ---------------------------
      // 创建密钥
      // ---------------------------
      if (path === "/create" && method === "POST") {
        const { email } = await request.json();
        if (!email || !email.includes("@"))
          return json({ ok: false, msg: "邮箱格式错误" }, baseHeaders);

        const [local_part, domain] = email.toLowerCase().split("@");
        const secret = randomKey(16);
        const ts = Date.now();

        await env.EmailSql
          .prepare(
            "INSERT INTO mailboxes (domain, local_part, email, secret_key, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"
          )
          .bind(domain, local_part, email, secret, ts)
          .run();

        return json({ ok: true, msg: "创建成功", key: secret }, baseHeaders);
      }

      return json({ ok: false, msg: "未找到接口" }, baseHeaders, 404);
    } catch (e) {
      return json({ ok: false, msg: e.message || String(e) }, baseHeaders, 500);
    }
  },
};

// ------------------------------
// 工具函数
// ------------------------------
function json(data, headers, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

function randomKey(len = 16) {
  const chars = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
  let str = "";
  for (let i = 0; i < len; i++)
    str += chars.charAt(Math.floor(Math.random() * chars.length));
  return str;
}
