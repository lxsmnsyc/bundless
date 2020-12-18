import { O_TRUNC } from 'constants'
import * as esbuild from 'esbuild'
import { promises } from 'fs-extra'
import { Config } from './config'
import { Graph } from './graph'
import { logger } from './logger'
import { osAgnosticPath } from './prebundle/support'

export interface Plugin {
    name: string
    setup: (build: PluginHooks) => void
}

type OnResolveCallback = (
    args: esbuild.OnResolveArgs,
) => Maybe<esbuild.OnResolveResult | Promise<Maybe<esbuild.OnResolveResult>>>

type OnLoadCallback = (
    args: esbuild.OnLoadArgs,
) => Maybe<esbuild.OnLoadResult | Promise<Maybe<esbuild.OnLoadResult>>>

type OnTransformCallback = (
    args: OnTransformArgs,
) => Maybe<OnTransformResult | Promise<Maybe<OnTransformResult>>>

type OnCloseCallback = () => void | Promise<void>

export interface PluginHooks {
    resolve: PluginsExecutor['resolve']
    config: Config
    graph: Graph
    onResolve(
        options: esbuild.OnResolveOptions,
        callback: OnResolveCallback,
    ): void
    onLoad(options: esbuild.OnLoadOptions, callback: OnLoadCallback): void
    onTransform(
        options: esbuild.OnLoadOptions,
        callback: OnTransformCallback,
    ): void
    onClose(options: any, callback: OnCloseCallback): void
}

export interface OnTransformArgs {
    path: string
    loader?: esbuild.Loader
    contents: string
}

export interface OnTransformResult {
    contents?: string
    map?: any
    loader?: esbuild.Loader
}

type Maybe<x> = x | undefined | null

export interface PluginsExecutor {
    load(args: esbuild.OnLoadArgs): Promise<Maybe<esbuild.OnLoadResult>>
    transform(args: OnTransformArgs): Promise<Maybe<OnTransformResult>>
    resolve(args: esbuild.OnResolveArgs): Promise<Maybe<esbuild.OnResolveArgs>>
    close({}): Promise<void>
}

export function createPluginsExecutor({
    plugins,
    config,
    graph,
    root,
}: {
    plugins: Plugin[]
    config: Config
    graph: Graph
    root: string
}): PluginsExecutor {
    type PluginObject<CB> = {
        name: string
        options: { filter: RegExp; namespace?: string }
        callback: CB
    }

    const transforms: PluginObject<OnTransformCallback>[] = []
    const resolvers: PluginObject<OnResolveCallback>[] = []
    const loaders: PluginObject<OnLoadCallback>[] = []
    const closers: PluginObject<OnCloseCallback>[] = []
    for (let plugin of plugins) {
        const { name, setup } = plugin
        setup({
            resolve,
            config,
            graph,
            onLoad: (options, callback) => {
                loaders.push({ options, callback, name })
            },
            onResolve: (options, callback) => {
                resolvers.push({ options, callback, name })
            },
            onTransform: (options, callback) => {
                transforms.push({ options, callback, name })
            },
            onClose: (options, callback) => {
                closers.push({ options, callback, name })
            },
        })
    }

    function matches(
        options: { filter: RegExp; namespace?: string },
        arg: { path?: string; namespace?: string },
    ) {
        if (!arg.path) {
            return false
        }
        if (options.filter && !options.filter.test(arg.path)) {
            return false
        }
        const optsNamespace = options.namespace || 'file'
        const argNamespace = arg.namespace || 'file'
        if (argNamespace !== optsNamespace) {
            return false
        }
        return true
    }

    async function load(arg) {
        let result
        for (let { callback, options, name } of loaders) {
            if (matches(options, arg)) {
                logger.debug(
                    `loading '${osAgnosticPath(
                        arg.path,
                        root,
                    )}' with '${name}'`,
                )
                const newResult = await callback(arg)
                if (newResult) {
                    result = newResult
                    break
                }
            }
        }
        if (result) {
            return { ...result, namespace: result.namespace || 'file' }
        }
    }
    async function transform(arg) {
        let result
        for (let { callback, options, name } of transforms) {
            if (matches(options, arg)) {
                logger.debug(`transforming '${arg.path}' with '${name}'`)
                const newResult = await callback(arg)
                if (newResult?.contents) {
                    arg.contents = newResult.contents
                    result = newResult
                }
                // break
            }
        }
        return result
    }
    async function resolve(arg) {
        let result
        for (let { callback, options, name } of resolvers) {
            if (matches(options, arg)) {
                logger.debug(`resolving '${arg.path}' with '${name}'`)
                const newResult = await callback(arg)
                if (newResult) {
                    logger.debug(
                        `resolved '${
                            arg.path
                        }' with '${name}' as '${osAgnosticPath(
                            newResult.path,
                            root,
                        )}'`,
                    )
                    result = newResult
                    break
                }
                // break
            }
        }
        if (result) {
            return { ...result, namespace: result.namespace || 'file' }
        }
    }
    async function close() {
        let result
        for (let { callback, options, name } of closers) {
            logger.debug(`cleaning resources for '${name}'`)
            await callback()
        }
        return result
    }

    return {
        load,
        resolve,
        transform,
        close,
    }
}
