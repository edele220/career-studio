const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const { BlockList, isIP } = require("node:net");
const { execFile } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const MAX_PAGE_SIZE = 2 * 1024 * 1024;
const OCR_LIMIT = 10 * 1024 * 1024;
const IMAGE_FORMATS = new Map([
  ["image/png", Buffer.from("89504e470d0a1a0a", "hex")],
  ["image/jpeg", Buffer.from("ffd8ff", "hex")],
  ["image/bmp", Buffer.from("BM")]
]);

const restrictedAddresses = new BlockList();
for (const [address, mask] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 3]
]) restrictedAddresses.addSubnet(address, mask, "ipv4");
for (const [address, mask] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) {
  restrictedAddresses.addSubnet(address, mask, "ipv6");
}
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !restrictedAddresses.check(address, "ipv4");
  return family === 6 && globalIpv6.check(address, "ipv6") && !restrictedAddresses.check(address, "ipv6");
}

function checkedUrl(value, base) {
  if (typeof value !== "string" || value.length > 4096) throw new Error("请输入有效的岗位链接。");
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error("请输入有效的岗位链接。");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error("请使用公开招聘网页的 HTTP 或 HTTPS 链接。");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new Error("请使用公开招聘网页的链接。");
  return url;
}

function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, family: options.family }, (error, addresses) => {
    if (error) return callback(error);
    const publicAddresses = addresses.filter(({ address }) => isPublicAddress(address));
    if (!publicAddresses.length) return callback(new Error("请使用公开招聘网页的链接。"));
    if (options.all) return callback(null, publicAddresses);
    const { address, family } = publicAddresses[0];
    callback(null, address, family);
  });
}

function decodePage(body, contentType) {
  const charset = contentType.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ||
    body.subarray(0, 4096).toString("latin1").match(/<meta\b[^>]*\bcharset\s*=\s*["']?([\w-]+)/i)?.[1];
  return new TextDecoder(charset || "utf-8").decode(body);
}

function requestPage(url, signal) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, {
      signal,
      agent: false,
      lookup: publicLookup,
      headers: { Accept: "text/html,application/xhtml+xml,text/plain", "User-Agent": "Career-Studio/1.0" }
    }, response => {
      response.on("error", reject);
      const { statusCode, headers } = response;
      if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
        resolve({ redirect: headers.location });
        response.destroy();
        return;
      }
      const contentType = headers["content-type"] || "";
      if (statusCode !== 200 || !/^(text\/(html|plain)|application\/xhtml\+xml)(\s*;|$)/i.test(contentType)) {
        reject(new Error("招聘页暂时无法读取，可能需要登录或不提供公开的 JD。"));
        response.destroy();
        return;
      }
      let size = 0;
      const chunks = [];
      response.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_PAGE_SIZE) {
          reject(new Error("招聘网页内容过大，请改用截图或粘贴 JD。"));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          resolve({ content: decodePage(Buffer.concat(chunks), contentType), isHtml: !/^text\/plain/i.test(contentType) });
        } catch {
          reject(new Error("无法读取网页的文字编码，请改用截图或粘贴 JD。"));
        }
      });
    });
    request.on("error", error => reject(new Error(error.code ? "招聘网页连接失败或读取超时，请改用截图或粘贴 JD。" : error.message)));
  });
}

async function readJobPage(value) {
  let url = checkedUrl(value);
  const signal = AbortSignal.timeout(9000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const result = await requestPage(url, signal);
    if (!result.redirect) return result;
    url = checkedUrl(result.redirect, url);
  }
  throw new Error("招聘链接跳转次数过多，请打开原网页查看或粘贴 JD。");
}

function recognizeScreenshot(image, type, language) {
  const signature = IMAGE_FORMATS.get(type);
  if (!signature || !image.subarray(0, signature.length).equals(signature)) {
    throw new Error("请选择有效的 PNG、JPG 或 BMP 截图。");
  }
  if (!["zh-Hans-CN", "en-US"].includes(language)) throw new Error("请选择简体中文或英语识别。");
  if (process.platform !== "win32") throw new Error("截图识别需要 Windows，请粘贴 JD 文本或手动录入。");

  const script = readFileSync(path.join(__dirname, "windows-ocr.ps1"), "utf8");
  const command = Buffer.from(script, "utf16le").toString("base64");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    const child = execFile(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", command], {
      env: { ...process.env, CAREER_STUDIO_OCR_LANGUAGE: language },
      timeout: 20000,
      maxBuffer: 256 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        console.warn("Windows OCR 失败：", stderr || error.message);
        return reject(new Error("无法识别这张截图。请换一张清晰的截图，或粘贴 JD 文本。"));
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error === "language") {
          return reject(new Error("当前 Windows 缺少所选语言的 OCR 组件。请在系统语言设置中安装，或粘贴 JD 文本。"));
        }
        if (!result.text?.trim()) return reject(new Error("截图里未识别到文字，请换一张清晰的截图。"));
        resolve({ text: result.text });
      } catch {
        reject(new Error("截图识别结果无法读取，请粘贴 JD 文本或手动录入。"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(image);
  });
}

module.exports = { OCR_LIMIT, readJobPage, recognizeScreenshot };
