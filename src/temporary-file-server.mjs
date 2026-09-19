// 单文件临时 HTTP 源站。
//
// 这个模块只解决“把一个明确选中的本地文件，以最小暴露面提供给反向代理/Tunnel”。
// 它本身只监听 loopback，绝不直接监听 0.0.0.0，因此没有 Cloudflare Tunnel 时，
// 局域网和公网都无法访问。
//
// 安全边界：
// - 每次启动生成 256 bit 随机 token，URL 不可枚举；
// - 只允许访问一个精确路径，不提供目录列表；
// - 只实现 GET / HEAD；
// - 支持单段 Range，便于 PikPak/代理做探测、重试和断点读取；
// - 默认 Cache-Control: no-store；
// - 统计请求次数和实际发出的文件字节，便于判断远端是否重复完整拉取。

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 把任意文件名转换为安全的 Content-Disposition。
 *
 * filename*=UTF-8''... 使用 RFC 5987 风格百分号编码，避免中文/空格被错误解释；
 * 不直接把原始文件名拼入 Header，从而杜绝换行/Header 注入问题。
 */
function contentDisposition(fileName) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * 解析一个单段 HTTP Range。
 *
 * 支持：
 *   bytes=0-99
 *   bytes=100-
 *   bytes=-100
 *
 * 不支持 multipart ranges；若收到多段 Range，返回 null，由调用方响应 416。
 */
export function parseSingleRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
  if (!match) return null;

  const [, startText, endText] = match;
  if (!startText && !endText) return null;
  if (fileSize === 0) return null;

  // 后缀 Range：bytes=-100，表示最后 100 字节。
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    const length = Math.min(suffixLength, fileSize);
    return {
      start: fileSize - length,
      end: fileSize - 1,
    };
  }

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= fileSize) return null;

  const end = endText ? Number(endText) : fileSize - 1;
  if (!Number.isSafeInteger(end) || end < start) return null;

  return {
    start,
    end: Math.min(end, fileSize - 1),
  };
}

/**
 * 启动只暴露一个本地文件的临时 HTTP server。
 *
 * @param {{
 *   filePath: string,
 *   host?: string,
 *   port?: number,
 *   tokenBytes?: number,
 * }} options
 * @returns {Promise<{
 *   host: string,
 *   port: number,
 *   localUrl: string,
 *   publicPath: string,
 *   fileName: string,
 *   fileSize: number,
 *   stats: {
 *     requests: number,
 *     getRequests: number,
 *     headRequests: number,
 *     rangeRequests: number,
 *     rejectedRequests: number,
 *     bytesServed: number,
 *   },
 *   close: () => Promise<void>,
 * }>}
 */
export async function createTemporaryFileServer({
  filePath,
  host = '127.0.0.1',
  port = 0,
  tokenBytes = 32,
}) {
  if (!filePath) throw new Error('filePath 不能为空。');
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('临时文件服务只允许绑定 loopback 地址。');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('port 必须是 0~65535 的整数。');
  }
  if (!Number.isInteger(tokenBytes) || tokenBytes < 16 || tokenBytes > 64) {
    throw new Error('tokenBytes 必须是 16~64；默认 32（256 bit）。');
  }

  const absolutePath = resolve(filePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error(`临时 HTTP 源站只支持普通文件: ${absolutePath}`);
  }

  const fileName = basename(absolutePath);
  const token = randomBytes(tokenBytes).toString('hex');
  const publicPath = `/file/${token}/${encodeURIComponent(fileName)}`;

  // stats 对象保持同一引用，调用方可以在传输过程中实时读取累计值。
  const stats = {
    requests: 0,
    getRequests: 0,
    headRequests: 0,
    rangeRequests: 0,
    rejectedRequests: 0,
    bytesServed: 0,
  };

  const server = createServer((request, response) => {
    stats.requests += 1;

    const method = String(request.method || 'GET').toUpperCase();
    const requestPath = new URL(request.url || '/', 'http://localhost').pathname;

    // 任意非精确随机路径都按 404 处理，不透露真实文件名、目录或 token 是否接近正确。
    if (requestPath !== publicPath) {
      stats.rejectedRequests += 1;
      response.writeHead(404, {
        'Cache-Control': 'no-store',
        'Content-Length': '0',
      });
      response.end();
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      stats.rejectedRequests += 1;
      response.writeHead(405, {
        Allow: 'GET, HEAD',
        'Cache-Control': 'no-store',
        'Content-Length': '0',
      });
      response.end();
      return;
    }

    if (method === 'GET') stats.getRequests += 1;
    if (method === 'HEAD') stats.headRequests += 1;

    const baseHeaders = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(fileName),
      'X-Content-Type-Options': 'nosniff',
    };

    const rangeHeader = request.headers.range;
    if (rangeHeader) {
      const range = parseSingleRange(rangeHeader, fileStat.size);
      if (!range) {
        stats.rejectedRequests += 1;
        response.writeHead(416, {
          ...baseHeaders,
          'Content-Range': `bytes */${fileStat.size}`,
          'Content-Length': '0',
        });
        response.end();
        return;
      }

      stats.rangeRequests += 1;
      const length = range.end - range.start + 1;
      response.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${fileStat.size}`,
        'Content-Length': String(length),
      });

      if (method === 'HEAD') {
        response.end();
        return;
      }

      // 只把请求的区间从磁盘流式读出，不把整个大文件塞进内存。
      const stream = createReadStream(absolutePath, {
        start: range.start,
        end: range.end,
      });
      stream.on('data', (chunk) => {
        stats.bytesServed += chunk.length;
      });
      stream.on('error', () => {
        // Header 已经发送后不能安全改成 500；直接销毁连接，让远端按普通网络失败处理。
        response.destroy();
      });
      stream.pipe(response);
      return;
    }

    response.writeHead(200, {
      ...baseHeaders,
      'Content-Length': String(fileStat.size),
    });

    if (method === 'HEAD') {
      response.end();
      return;
    }

    const stream = createReadStream(absolutePath);
    stream.on('data', (chunk) => {
      stats.bytesServed += chunk.length;
    });
    stream.on('error', () => {
      response.destroy();
    });
    stream.pipe(response);
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('无法确定临时 HTTP server 的监听端口。');
  }

  const actualPort = address.port;
  const localUrl = `http://${host === '::1' ? '[::1]' : host}:${actualPort}${publicPath}`;

  return {
    host,
    port: actualPort,
    localUrl,
    publicPath,
    fileName,
    fileSize: fileStat.size,
    stats,
    async close() {
      if (!server.listening) return;
      await new Promise((resolveClose, rejectClose) => {
        // Node 18+ close() 会等待现有连接结束；这里不粗暴中断正在读取的数据。
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },
  };
}
