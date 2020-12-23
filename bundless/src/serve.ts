import chalk from 'chalk'
import chokidar, { FSWatcher } from 'chokidar'
import deepmerge from 'deepmerge'
import { once } from 'events'
import { Server } from 'http'
import Koa, { DefaultContext, DefaultState, Middleware } from 'koa'
import { listen } from 'listhen'
import path from 'path'
import slash from 'slash'
import WebSocket from 'ws'
import { HMRPayload } from './client/types'
import { Config, defaultConfig, getEntries } from './config'
import {
    DEFAULT_PORT,
    HMR_SERVER_NAME,
    importableAssets,
    JS_EXTENSIONS,
    MAIN_FIELDS,
    showGraph,
    WEB_MODULES_PATH,
} from './constants'
import { Graph } from './graph'
import { onFileChange } from './hmr'
import { logger } from './logger'
import * as middlewares from './middleware'
import { createPluginsExecutor, PluginsExecutor } from './plugin'
import * as plugins from './plugins'
import { prebundle } from './prebundle'
import { BundleMap } from './prebundle/esbuild'
import { genSourceMapString } from './sourcemaps'
import {
    dotdotEncoding,
    importPathToFile,
    needsPrebundle,
    readBody,
} from './utils'
import fs from 'fs-extra'
import etagMiddleware from 'koa-etag'

export interface ServerPluginContext {
    root: string
    app: Koa
    graph: Graph
    pluginExecutor: PluginsExecutor
    // server: Server
    watcher: FSWatcher
    server?: Server
    config: Config
    sendHmrMessage: (payload: HMRPayload) => void
    port: number
}

export type ServerMiddleware = (ctx: ServerPluginContext) => void

export async function serve(config: Config) {
    config = deepmerge(defaultConfig, config)
    const app = await createApp(config)
    const { server, close } = await listen(app.callback(), {
        port: config.port || DEFAULT_PORT,
        showURL: true,
        clipboard: false,
        autoClose: true,
        open: config.openBrowser,
    })
    app.context.server = server
    app.emit('listening')
    const port = server.address()?.['port']
    app.context.port = port
    config.port = port
    return {
        ...server,
        close: async () => {
            app.emit('close')
            await once(app, 'closed')
            return await close()
        },
    }
}

export async function createApp(config: Config) {
    if (!config.root) {
        config.root = process.cwd()
    }
    const { root } = config

    const app = new Koa<DefaultState, DefaultContext>()

    const graph = new Graph({ root })
    const bundleMapCachePath = path.resolve(
        root,
        WEB_MODULES_PATH,
        'bundleMap.json',
    )
    let bundleMap: BundleMap = await fs
        .readJSON(bundleMapCachePath)
        .catch(() => ({}))
    async function onResolved(resolvedPath: string, importer: string) {
        if (!needsPrebundle(config, resolvedPath)) {
            return
        }
        const relativePath = slash(path.relative(root, resolvedPath)).replace(
            '$$virtual',
            'virtual',
        )
        if (bundleMap && bundleMap[relativePath]) {
            const webBundle = bundleMap[relativePath]
            return path.resolve(root, webBundle!)
        }
        logger.log(`Found still not bundled module, running prebundle phase:`)
        logger.log(`'${relativePath}' imported by '${importer}'`)
        // node module path not bundled, rerun bundling
        const entryPoints = getEntries(config)
        bundleMap = await prebundle({
            entryPoints,
            filter: (p) => needsPrebundle(config, p),
            dest: path.resolve(root, WEB_MODULES_PATH),
            root,
        }).catch((e) => {
            e.message = `Cannot prebundle: ${e.message}`
            throw e
        })
        await fs.writeJSON(bundleMapCachePath, bundleMap, { spaces: 4 })
        // TODO store the bundleMap on disk
        context.sendHmrMessage({ type: 'reload' })
        const webBundle = bundleMap[relativePath]
        if (!webBundle) {
            throw new Error(
                `Bundle for '${relativePath}' was not generated in prebundling phase\n${JSON.stringify(
                    bundleMap,
                    null,
                    4,
                )}`,
            )
        }
        return path.resolve(root, webBundle)
        // lock server, start optimization, unlock, send refresh message
    }

    const pluginExecutor = createPluginsExecutor({
        root,
        plugins: [
            // TODO resolve data: imports, rollup emits imports with data: ...
            plugins.UrlResolverPlugin(), // resolves urls with queries
            plugins.HmrClientPlugin({ getPort: () => app.context.port }),
            // NodeResolvePlugin must be called first, to not skip prebundling
            plugins.NodeResolvePlugin({
                name: 'node-resolve',
                mainFields: MAIN_FIELDS,
                extensions: [...JS_EXTENSIONS],
                onResolved,
            }),
            plugins.AssetsPlugin({ extensions: importableAssets }),
            plugins.NodeModulesPolyfillPlugin({ namespace: 'node-builtins' }),
            plugins.EsbuildTransformPlugin(),
            plugins.CssPlugin(),
            plugins.JSONPlugin(),
            ...(config.plugins || []),
            plugins.ResolveSourcemapPlugin(),
            plugins.RewritePlugin(),
        ],
        config,
        graph,
    })

    let useFsEvents = false
    try {
        eval('require')('fsevents')
        useFsEvents = true
    } catch (e) {}

    const watcher = chokidar.watch(root, {
        // cwd: root,
        // disableGlobbing: true,
        ignored: [
            /(^|[/\\])(node_modules|\.git|\.DS_Store|web_modules)([/\\]|$)/,
            // TODO dont watch output directory
            // path.resolve(root, out),
            // path.resolve(root, distDir),
        ],
        useFsEvents,
        ignoreInitial: true,
        //   ...chokidarWatchOptions
    })

    app.once('close', async () => {
        logger.debug('closing')
        await Promise.all([watcher.close(), pluginExecutor.close({})])
        app.emit('closed')
    })

    // app.on('error', (e) => {
    //     logger.log(chalk.red(e))
    // })

    // start HMR ws server
    app.once('listening', async () => {
        const wss = new WebSocket.Server({ noServer: true })
        app.once('close', () => {
            wss.close(() => logger.debug('closing wss'))
            wss.clients.forEach((client) => {
                client.close()
            })
        })
        if (!app.context.server) {
            throw new Error(`Cannot find server in context`)
        }
        app.context.server.on('upgrade', (req, socket, head) => {
            if (req.headers['sec-websocket-protocol'] === HMR_SERVER_NAME) {
                wss.handleUpgrade(req, socket, head, (ws) => {
                    wss.emit('connection', ws, req)
                })
            }
        })

        wss.on('connection', (socket) => {
            socket.send(JSON.stringify({ type: 'connected' }))
            socket.on('message', (data) => {
                const message: HMRPayload = JSON.parse(data.toString())
                if (message.type === 'hotAccept') {
                    graph.ensureEntry(importPathToFile(root, message.path), {
                        hasHmrAccept: true,
                        isHmrEnabled: true,
                    })
                }
            })
        })

        wss.on('error', (e: Error & { code: string }) => {
            if (e.code !== 'EADDRINUSE') {
                console.error(chalk.red(`WebSocket server error:`))
                console.error(e)
            }
        })

        context.sendHmrMessage = (payload: HMRPayload) => {
            const stringified = JSON.stringify(payload, null, 4)
            logger.log(`hmr: ${stringified}`)
            if (!wss.clients.size) {
                logger.log(chalk.yellow(`No clients listening for HMR message`))
            }
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(stringified)
                } else {
                    console.log(
                        chalk.red(
                            `Cannot send HMR message, hmr client is not open`,
                        ),
                    )
                }
            })
        }
    })

    // changing anything inside root that is not ignored and that is not in graph will cause reload
    if (config.hmr) {
        watcher.on('change', (filePath) => {
            onFileChange({
                graph,
                filePath,
                root,
                sendHmrMessage: context.sendHmrMessage,
            })
            if (showGraph) {
                logger.log(graph.toString())
            }
        })
    }

    const context: ServerPluginContext = {
        root,
        app,
        watcher,
        config,
        graph,
        pluginExecutor,
        sendHmrMessage: () => {
            // assigned in the hmr middleware
            throw new Error(`hmr ws server has not started yet`)
        },
        // port is exposed on the context for hmr client connection
        // in case the files are served under a different port
        port: Number(config.port || 3000),
    }

    // only js ends up here
    const pluginsMiddleware = (): Middleware => {
        // attach server context to koa context
        return async (ctx, next) => {
            // Object.assign(ctx, context)
            const req = ctx.req
            if (
                ctx.query.namespace == null &&
                // esm imports accept */* in most browsers
                req.headers['accept'] !== '*/*' &&
                req.headers['sec-fetch-dest'] !== 'script'
            ) {
                return next()
            }

            if (ctx.path.startsWith('.')) {
                throw new Error(
                    `All import paths should have been rewritten to absolute paths (start with /)\n` +
                        ` make sure import paths for '${ctx.path}' are statically analyzable`,
                )
            }

            const isVirtual =
                ctx.query.namespace && ctx.query.namespace !== 'file'
            // do not resolve virtual files like node builtins to an absolute path
            const resolvedPath = isVirtual
                ? ctx.path.slice(1) // remove leading /
                : importPathToFile(root, ctx.path)

            // watch files outside root
            if (
                ctx.path.startsWith('/' + dotdotEncoding) &&
                !resolvedPath.includes('node_modules')
            ) {
                watcher.add(resolvedPath)
            }

            const namespace = ctx.query.namespace || 'file'
            const loaded = await pluginExecutor.load({
                path: resolvedPath,
                namespace,
            })
            if (loaded == null || loaded.contents == null) {
                return next()
            }
            const transformed = await pluginExecutor.transform({
                path: resolvedPath,
                loader: loaded.loader,
                namespace,
                contents: String(loaded.contents),
            })
            if (transformed == null) {
                return next()
            }
            const sourcemap = transformed.map
                ? genSourceMapString(transformed.map)
                : ''

            ctx.body = transformed.contents + sourcemap
            ctx.status = 200
            ctx.type = 'js'
            return next()
        }
    }

    // app.use((_, next) => {
    //     console.log(graph.toString())
    //     return next()
    // })

    app.use(middlewares.sourcemapMiddleware({ root }))
    app.use(middlewares.pluginAssetsMiddleware())
    app.use(pluginsMiddleware())
    app.use(middlewares.staticServeMiddleware({ root })) // TODO test that serve static works with paths containing $$ and folders with name ending in .zip
    app.use(
        middlewares.staticServeMiddleware({ root: path.join(root, 'public') }),
    )
    app.use(middlewares.historyFallbackMiddleware({ root }))
    // app.use(require('koa-conditional-get'))
    app.use(etagMiddleware())

    // transform html
    app.use(async (ctx, next) => {
        // const accept = ctx.headers.accept
        if (!ctx.response.is('html') || ctx.status >= 400) {
            return next()
        }
        const publicPath = !path.extname(ctx.path)
            ? path.posix.join(ctx.path, 'index.html')
            : ctx.path
        // logger.log('transforming html ' + publicPath)
        let html = await readBody(ctx.body)
        if (!html) {
            return next()
        }
        const transformedHtml = await pluginExecutor.transform({
            contents: html,
            path: importPathToFile(root, publicPath),
            namespace: 'file',
        })
        // console.log({ transformedHtml })
        if (!transformedHtml) {
            return next()
        }
        ctx.body = transformedHtml.contents
        ctx.status = 200
        ctx.type = 'html'
    })

    // cors
    if (config.cors) {
        app.use(
            require('@koa/cors')(
                typeof config.cors === 'boolean' ? {} : config.cors,
            ),
        )
    }

    return app
}

function etagCache() {
    return function conditional() {
        return async function(ctx, next) {
            await next()

            if (ctx.fresh) {
                ctx.status = 304
                ctx.body = null
            }
        }
    }
}