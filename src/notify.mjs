import { pathToFileURL } from "node:url";

function truncate(text) {
  const s = String(text ?? "");
  if (s.length > 4000) return s.slice(0, 4000) + "…";
  return s;
}

export async function notify(text) {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("missing TG_BOT_TOKEN/TG_CHAT_ID");
  }
  const payload = {
    chat_id: chatId,
    text: truncate(text),
    disable_web_page_preview: true,
  };
  if (process.env.TG_DRY === "1") {
    return payload;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(e?.message || String(e));
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data || data.ok !== true) {
    const msg = (data && (data.description || data.error)) || res.statusText || "request failed";
    throw new Error(msg);
  }
  return data;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  (async () => {
    const token = process.env.TG_BOT_TOKEN;
    const chatId = process.env.TG_CHAT_ID;
    if (!token || !chatId) {
      process.stderr.write("missing TG_BOT_TOKEN/TG_CHAT_ID\n");
      process.exit(2);
    }
    const text =
      process.argv[2] !== undefined ? process.argv[2] : await readStdin();
    if (process.env.TG_DRY === "1") {
      const payload = {
        chat_id: chatId,
        text: truncate(text),
        disable_web_page_preview: true,
      };
      process.stdout.write(JSON.stringify(payload) + "\n");
      process.exit(0);
    }
    try {
      await notify(text);
    } catch (e) {
      process.stderr.write((e?.message || String(e)) + "\n");
      process.exit(1);
    }
  })();
}
