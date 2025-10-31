import PostalMime from "postal-mime";

export default {
  async email(message, env, ctx) {
    const FALLBACK_GMAIL = "ztjs999999@gmail.com";
    const now = () => Date.now();

    try {
      // 1) 解析整封邮件
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

      // 3) 先入库（status 固定 o1）
      try {
        await env.EmailSql.prepare(
          `INSERT INTO email_inbox
           (domain, local_part, to_email, from_email, subject, body_text, status, created_at, message_id)
           VALUES (?, ?, ?, ?, ?, ?, 'o1', ?, ?)`
        )
        .bind(domain, localPart, toEmail, from, subject, bodyText, createdAt, messageId)
        .run();
        console.log("DB insert ok:", toEmail || "(unknown)", subject);
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes("idx_inbox_msgid")) {
          console.warn("Duplicate message_id, skip insert:", messageId);
        } else {
          console.error("DB insert error (continue):", msg);
        }
      }

      // 4) 查 mailboxes，未登记/禁用则异步转发
      let needForward = false;
      if (!localPart || !domain) {
        needForward = true;
        console.warn("Recipient parse failed; will forward to Gmail");
      } else {
        try {
          const mb = await env.EmailSql
            .prepare("SELECT status FROM mailboxes WHERE domain=? AND local_part=? LIMIT 1")
            .bind(domain, localPart)
            .first();
          if (!mb || mb.status !== "active") {
            needForward = true;
            console.log("Mailbox not registered/active; will forward:", toEmail);
          }
        } catch (e) {
          needForward = true;
          console.error("mailboxes query error; fallback forward:", String(e?.message || e));
        }
      }

      if (needForward) {
        ctx.waitUntil(
          (async () => {
            try {
              await message.forward(FALLBACK_GMAIL);
              console.log("Forwarded to Gmail:", FALLBACK_GMAIL, "for", toEmail || "(unknown)");
            } catch (err) {
              console.error("Forward to Gmail failed:", String(err?.message || err));
            }
          })()
        );
      }
    } catch (err) {
      console.error("postal-mime parse failed; fallback forward:", String(err?.message || err));
      // 解析失败也保证转发，不丢信
      ctx.waitUntil(message.forward("ztjs999999@gmail.com"));
    }

    // 始终 200，避免重试
    return new Response("ok", { status: 200 });
  },
};
