// dsh-mcu51 插件入口：把 51 单片机的“手”接进 DSH。
// 这里只做宿主绑定；所有逻辑在 lib/ 下的纯函数模块里，可脱离 Cordis 直接测。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { registerTools } from '../lib/tools.js'

export const name = 'dsh-mcu51'
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{dataDir?: string, keilPath?: string,
 *          defaultPort?: string, defaultMcu?: string, flashWaitSeconds?: number,
 *          searchRoots?: string[], serialBauds?: number[]}} config
 */
export function apply(ctx, config = {}) {
  const dispose = registerTools({ tools: ctx.tools, defineTool }, config)
  console.log('[dsh-mcu51] 已注册 ' + dispose.toolNames.length + ' 个工具：' + dispose.toolNames.join(' / '))
  return dispose
}
