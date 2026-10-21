import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * 构建时戳写进 <title>：静态文件部署后浏览器常常继续用缓存里的旧产物，
 * 页面上又没有可辨识的版本标记，两边就会对着不同的构建讨论。
 * 标题里带时间戳，一眼能看出当前页面跑的是哪一次构建。
 */
function buildStamp(): Plugin {
  return {
    name: 'build-stamp',
    transformIndexHtml(html) {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp =
        d.getFullYear() +
        '-' + pad(d.getMonth() + 1) +
        '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) +
        ':' + pad(d.getMinutes());
      return html.replace('</title>', ' [' + stamp + ']</title>');
    }
  };
}

export default defineConfig({
  plugins: [buildStamp(), viteSingleFile()],
  build: {
    target: 'es2017',
    assetsInlineLimit: 100000000,
    cssCodeSplit: false
  }
});
