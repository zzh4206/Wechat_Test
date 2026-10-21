// http-guard.mjs —— 本机 Web 服务的特有威胁对策（前端设计 §6.2）。
//
// 127.0.0.1 端口能被浏览器里任意网页访问，所以每个请求都要过：
// - Host 校验（防 DNS rebinding）：只认 127.0.0.1:<port> / localhost:<port>；
// - Origin 校验：带 Origin 头时必须是本服务自己（GET 也查，跨站读取直接拒）；
// - token 校验（防 CSRF/越权读）：/api/* 必须带 `Authorization: Bearer <token>`，常数时间比较；
// - 安全响应头：严格 CSP、禁嵌入、禁 MIME 嗅探、不带 Referer；**不发任何 CORS 头**。
import { createHash, timingSafeEqual } from 'node:crypto'

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
})

/** Host 头是否指向本服务 */
export function hostAllowed(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

/** Origin 头（若有）是否为本服务 */
export function originAllowed(origin, port) {
  if (origin === undefined) return true
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

const digest = (s) => createHash('sha256').update(String(s), 'utf8').digest()

/**
 * token 指纹 = sha256 十六进制前 8 位，与插件审计 operator 同算法（RUNBOOK §13.3）。
 * 用于和插件清单里的指纹比对、写进动作行；绝不落原 token。
 */
export function operatorOf(token) {
  return digest(token).toString('hex').slice(0, 8)
}

/** Authorization 头是否携带正确 token（先 sha256 再比，长度恒定，避免长度泄露） */
export function tokenAllowed(authorization, token) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
  return timingSafeEqual(digest(authorization.slice('Bearer '.length)), digest(token))
}
