import PostalMime from "postal-mime";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ✅ 跨域支持
    const baseHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };

    try {
      // ---- 验证密钥 ----
      if (path === "/verify" && method === "POST") {
        const { key } = await request.json();
        if (!key) return new Response(JSON.stringify({ ok: false, msg: "缺少密钥" }), { headers: baseHeaders });

        const res = await env.EmailSql
          .prepare("SELECT email, domain, local_part, status FROM mailboxes WHERE secret_key = ? LIMIT 1")
          .bind(key)
          .first();
        if (!res) return new Response(JSON.stringify({ ok: false, msg: "密钥无效" }), { headers: baseHeaders });
        if (res.status !== "active") return new Response(JSON.stringify({ ok: false, msg: "密钥已失效" }), { headers: baseHeaders });

        return new Response(JSON.stringify({ ok: true, msg: "验证成功", email: res.email }), { headers: baseHeaders });
      }

      // ---- 查询收件箱 ----
      if (path === "/inbox" && method === "GET") {
        const key = url.searchParams.get("key");
        if (!key) return new Response(JSON.stringify({ ok: false, msg: "缺少密钥" }), { headers: baseHeaders });

        const box = await env.EmailSql
          .prepare("SELECT email, domain, local_part FROM mailboxes WHERE secret_key = ? LIMIT 1")
          .bind(key)
          .first();
        if (!box) return new Response(JSON.stringify({ ok: false, msg: "密钥无效" }), { headers: baseHeaders });

        const mails = await env.EmailSql
          .prepare(
            "SELECT id, from_email, subject, body_text, created_at FROM email_inbox WHERE domain=? AND local_part=? AND status='o1' ORDER BY created_at DESC LIMIT 10"
          )
          .bind(box.domain, box.local_part)
          .all();

        return new Response(JSON.stringify({ ok: true, list: mails.results }), { headers: baseHeaders });
      }

      // ---- 删除邮件 ----
      if (path === "/delete" && method === "POST") {
        const { key, id } = await request.json();
        if (!key || !id) return new Response(JSON.stringify({ ok: false, msg: "缺少参数" }), { headers: baseHeaders });

        const box = await env.EmailSql
          .prepare("SELECT domain, local_part FROM mailboxes WHERE secret_key = ? LIMIT 1")
          .bind(key)
          .first();
        if (!box) return new Response(JSON.stringify({ ok: false, msg: "密钥无效" }), { headers: baseHeaders });

        await env.EmailSql
          .prepare("UPDATE email_inbox SET status='o2' WHERE id=? AND domain=? AND local_part=?")
          .bind(id, box.domain, box.local_part)
          .run();

        return new Response(JSON.stringify({ ok: true, msg: "邮件已删除" }), { headers: baseHeaders });
      }

      // ---- 创建新密钥 ----
      if (path === "/create" && method === "POST") {
        const { email } = await request.json();
        if (!email || !email.includes("@")) return new Response(JSON.stringify({ ok: false, msg: "邮箱格式错误" }), { headers: baseHeaders });

        const [local_part, domain] = email.toLowerCase().split("@");
        const secret = randomKey(16);
        const ts = Date.now();

        await env.EmailSql
          .prepare(
            "INSERT INTO mailboxes (domain, local_part, email, secret_key, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"
          )
          .bind(domain, local_part, email, secret, ts)
          .run();

        return new Response(JSON.stringify({ ok: true, msg: "创建成功", key: secret }), { headers: baseHeaders });
      }

      return new Response(JSON.stringify({ ok: false, msg: "Not Found" }), { status: 404, headers: baseHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, msg: e.message || String(e) }), { headers: baseHeaders });
    }
  },

  // ✉️ 邮件入口（保持你现有逻辑）
  async email(message, env, ctx) {
    // ...这里放你原来的接收逻辑，不动...
  },
};

// 生成随机密钥
function randomKey(len = 16) {
  const chars = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
  let str = "";
  for (let i = 0; i < len; i++) str += chars.charAt(Math.floor(Math.random() * chars.length));
  return str;
}
