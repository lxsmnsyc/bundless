import { listen } from 'listhen'
import { DEFAULT_PORT } from './constants'
import { FSWatcher } from 'chokidar'
import { Server } from 'http'
import { pluginAssetsPlugin, serveStaticPlugin } from './middleware'
export interface ServerPluginContext {
    root: string
    app: Koa
    // server: Server
    watcher: FSWatcher
    config: Config
    port: number
}

export type ServerPlugin = (ctx: ServerPluginContext) => void

export interface Config {
    root: string
}

export async function serve(config) {
    const handler = createHandler(config)
    const { server } = await listen(handler, {
        port: config.port || DEFAULT_PORT,
        showURL: true,
    })
    return server
}

import Koa, { DefaultState, DefaultContext } from 'koa'
import chokidar from 'chokidar'
import { createPluginsExecutor } from './plugin'

export function createHandler(config) {
    const { root = process.cwd() } = config

    const app = new Koa<DefaultState, DefaultContext>()
    const watcher = chokidar.watch(root, {
        ignored: ['**/node_modules/**', '**/.git/**'],
        ignoreInitial: true,
        //   ...chokidarWatchOptions
    })

    const context: ServerPluginContext = {
        root,
        app,
        watcher,
        config,
        // port is exposed on the context for hmr client connection
        // in case the files are served under a different port
        port: config.port || 3000,
    }

    const pluginExecutor = createPluginsExecutor({ plugins: [] })

    // attach server context to koa context
    app.use((ctx, next) => {
        Object.assign(ctx, context)

        return next()
    })

    const serverMiddleware = [pluginAssetsPlugin, serveStaticPlugin]
    for (const middleware of serverMiddleware) {
        middleware(context)
    }

    // cors
    if (config.cors) {
        app.use(
            require('@koa/cors')(
                typeof config.cors === 'boolean' ? {} : config.cors,
            ),
        )
    }

    return app.callback()
}
