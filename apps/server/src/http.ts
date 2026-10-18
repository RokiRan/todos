/**
 * 路由层共用的 HTTP 错误类型与工具。
 *
 * 之前 todos / chief 各自定义了一个 `class HttpError`（结构相同），
 * 而 Fastify 默认把任何抛出的 Error 都当 500 —— 结果 404/409/422
 * 全变成 `{"error":"internal error"}`，客户端无法区分「重试有意义」
 * 与「请求本身错了」，闸门越权也被误报成服务端故障。
 *
 * 现在统一从这里取，并配合 installErrorHandlers 按 statusCode 返回。
 */

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 鸭子类型识别：任何带数值 statusCode 的错误都按业务错误处理。 */
export function isHttpError(err: unknown): err is Error & { statusCode: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { statusCode?: unknown }).statusCode === 'number'
  );
}

/**
 * 安装错误处理。
 *
 * 必须在**所有路由注册之后**调用 —— Fastify 的 setErrorHandler 只作用于
 * 调用时刻已存在的路由，写在 registerXxxRoutes 之前会静默失效
 * （症状是 handler 从不被调用，错误仍走默认 500）。
 */
export function installErrorHandlers(app: {
  setErrorHandler(fn: (err: unknown, req: unknown, reply: { code(n: number): { send(body: unknown): unknown } }) => void): void;
  setNotFoundHandler(fn: (req: unknown, reply: { code(n: number): { send(body: unknown): unknown } }) => void): void;
  log: { error(obj: unknown, msg?: string): void };
}): void {
  app.setErrorHandler((err, _req, reply) => {
    if (isHttpError(err)) {
      reply.code(err.statusCode).send({ error: err.message });
      return;
    }
    app.log.error({ err }, 'unhandled error');
    reply.code(500).send({ error: 'internal error' });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'not found' });
  });
}
