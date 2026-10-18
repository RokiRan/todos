import manifest from '../../lib/pwa-manifest';

/**
 * `GET /manifest.webmanifest`
 *
 * 路径与文件名都照抄原站（不是 Next 默认的 /manifest.webmanifest?no-cache=1）——
 * 安装器、Chrome 与原站缓存的 manifest 都指向这个精确 URL。
 */
export async function GET(): Promise<Response> {
  return new Response(JSON.stringify(manifest), {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
