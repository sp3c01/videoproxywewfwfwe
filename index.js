const express = require("express");
const { Readable } = require("stream");
const app = express();
const PORT = process.env.PORT || 3000;

const MAX_CHUNK = 5 * 1024 * 1024;
const FETCH_TIMEOUT = 30000;

function isPrivateHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local")
  );
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "range, content-type, referer");
  res.header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/proxy-video", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: "Missing ?url=" });
  if (!targetUrl.startsWith("http://"))
    return res.status(400).json({ error: "Only http:// URLs" });

  try {
    const parsed = new URL(targetUrl);
    if (isPrivateHost(parsed.hostname))
      return res.status(403).json({ error: "Blocked: private IP" });
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      Accept: "*/*",
    };

    const clientRange = req.headers.range;
    if (clientRange) {
      headers["Range"] = clientRange;
    } else {
      headers["Range"] = `bytes=0-${MAX_CHUNK - 1}`;
    }

    if (req.headers.referer) headers["Referer"] = req.headers.referer;

    let currentUrl = targetUrl;
    let upstream = null;

    for (let i = 0; i < 5; i++) {
      upstream = await fetch(currentUrl, {
        headers,
        redirect: "manual",
        signal: controller.signal,
      });

      if (upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get("location");
        await upstream.body?.cancel();
        if (!location) break;
        const resolved = new URL(location, currentUrl).toString();
        try {
          if (isPrivateHost(new URL(resolved).hostname))
            return res.status(403).json({ error: "Blocked: redirect to private IP" });
        } catch {
          return res.status(400).json({ error: "Invalid redirect URL" });
        }
        currentUrl = resolved;
        continue;
      }
      break;
    }

    clearTimeout(timeout);

    if (!upstream) return res.status(502).json({ error: "No response" });

    res.status(upstream.status);
    res.set("Cache-Control", "public, max-age=86400");

    const ct = upstream.headers.get("content-type");
    if (ct) res.set("Content-Type", ct);
    const cl = upstream.headers.get("content-length");
    if (cl) res.set("Content-Length", cl);
    const cr = upstream.headers.get("content-range");
    if (cr) res.set("Content-Range", cr);
    res.set("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");

    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body, { highWaterMark: 65536 });

      res.on("close", () => {
        if (!nodeStream.destroyed) nodeStream.destroy();
      });

      nodeStream.on("error", () => {
        if (!res.destroyed) res.end();
      });

      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    clearTimeout(timeout);
    console.error("proxy-video error:", e.message);
    if (!res.headersSent) res.status(502).json({ error: "Proxy error" });
  }
});

app.get("/", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`Proxy on port ${PORT}`));
