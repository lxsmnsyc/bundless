import { NodeModulesPolyfillPlugin, NodeResolvePlugin } from '../plugins'
import deepmerge from 'deepmerge'
import { build, BuildOptions, Metadata, Plugin } from 'esbuild'
import { promises as fsp } from 'fs'
import fsx, { copySync } from 'fs-extra'
import os from 'os'
import path from 'path'
import slash from 'slash'
import { isRunningWithYarnPnp, JS_EXTENSIONS, MAIN_FIELDS } from '../constants'

import { removeColonsFromMeta } from './support'
import fromEntries from 'fromentries'
import { stripColon, unique } from './support'
import { flatten } from '../utils'
import { logger } from '../logger'

type Args = {
    cwd: string
    entryPoints: string[]
    esbuildOptions?: Partial<BuildOptions>
    // resolver?: (cwd: string, id: string) => string
    stopTraversing?: (resolvedPath: string) => boolean
}

export type TraversalResultType = {
    resolvedImportPath: string
    importer: string
}

export async function traverseWithEsbuild({
    entryPoints,
    cwd: esbuildCwd,
    esbuildOptions = { plugins: [] },
    stopTraversing,
}: Args): Promise<TraversalResultType[]> {
    const destLoc = await fsp.realpath(
        path.resolve(await fsp.mkdtemp(path.join(os.tmpdir(), 'dest'))),
    )

    for (let entry of entryPoints) {
        if (!path.isAbsolute(entry)) {
            throw new Error(
                `All entryPoints of traverseWithEsbuild must be absolute: ${entry}`,
            )
        }
    }

    try {
        const metafile = path.join(destLoc, 'meta.json')

        await build(
            deepmerge(
                {
                    // splitting: true, // needed to dedupe modules
                    // external: externalPackages,
                    target: 'es2020',
                    minifyIdentifiers: false,
                    minifySyntax: false,
                    minifyWhitespace: false,
                    mainFields: MAIN_FIELDS,
                    sourcemap: false,
                    define: {
                        'process.env.NODE_ENV': JSON.stringify('dev'),
                        global: 'window',
                        // ...generateEnvReplacements(env),
                    },
                    // inject: [
                    //     // require.resolve(
                    //     //     '@esbuild-plugins/node-globals-polyfill/process.js',
                    //     // ),
                    // ],
                    // tsconfig: ,
                    loader: {
                        '.js': 'jsx',
                    },

                    plugins: [
                        ExternalButInMetafile(),
                        NodeModulesPolyfillPlugin(),
                        NodeResolvePlugin({
                            mainFields: MAIN_FIELDS,
                            extensions: [...JS_EXTENSIONS],
                            onResolved: function external(resolved) {
                                // console.log({resolved})
                                if (
                                    stopTraversing &&
                                    stopTraversing(resolved)
                                ) {
                                    return {
                                        namespace: externalNamespace,
                                        path: resolved,
                                    }
                                }
                                return
                            },
                            onNonResolved: (p) => {
                                console.error(
                                    `Cannot resolve '${p}' during traversal`,
                                )
                                // return {
                                //     external: true,
                                // }
                            },
                            resolveOptions: {
                                // preserveSymlinks: isRunningWithYarnPnp || false,
                                extensions: [...JS_EXTENSIONS],
                            },
                        }),
                    ].filter(Boolean),
                    bundle: true,
                    platform: 'browser',
                    format: 'esm',
                    write: true,
                    entryPoints,
                    outdir: destLoc,
                    minify: false,
                    logLevel: 'info',
                    metafile,
                } as BuildOptions,
                esbuildOptions,
            ),
        )

        let meta: Metadata = JSON.parse(
            await (await fsp.readFile(metafile)).toString(),
        )
        meta = removeColonsFromMeta(meta)
        // console.log(JSON.stringify(meta, null, 4))

        const res = flatten(
            entryPoints.map((entry) => {
                return metaToTraversalResult({ meta, entry, esbuildCwd })
            }),
        ).map((x) => {
            return {
                ...x,
                resolvedImportPath: x.resolvedImportPath,
                importer: x.importer,
            }
        })

        return res
    } finally {
        await fsx.remove(destLoc)
    }
}

const externalNamespace = 'external-but-keep-in-metafile'
function ExternalButInMetafile(): Plugin {
    return {
        name: externalNamespace,
        setup(build) {
            const externalModule = 'externalModuleXXX'
            build.onResolve(
                {
                    filter: new RegExp(externalModule),
                    namespace: externalNamespace,
                },
                (args) => {
                    if (args.path !== externalModule) {
                        return
                    }
                    return {
                        external: true,
                    }
                },
            )
            build.onLoad(
                {
                    filter: /.*/,
                    namespace: externalNamespace,
                },
                (args) => {
                    const contents = `export * from '${externalModule}'`
                    return {
                        contents,
                        loader: 'js',
                        // resolveDir: path.dirname(args.path),
                    }
                },
            )
        },
    }
}

export function metaToTraversalResult({
    meta,
    entry,
    esbuildCwd,
}: {
    meta: Metadata
    esbuildCwd: string
    entry: string
}): TraversalResultType[] {
    if (!path.isAbsolute(esbuildCwd)) {
        throw new Error('esbuildCwd must be an absolute path')
    }
    if (!path.isAbsolute(entry)) {
        throw new Error('entry must be an absolute path')
    }
    const alreadyProcessed = new Set<string>()
    let toProcess = [slash(path.relative(esbuildCwd, entry))]
    let result: TraversalResultType[] = []
    const inputs = fromEntries(
        Object.keys(meta.inputs).map((k) => {
            const abs = path.resolve(esbuildCwd, k)
            return [abs, meta.inputs[k]]
        }),
    )
    while (toProcess.length) {
        const newImports = flatten(
            toProcess.map((newEntry) => {
                if (alreadyProcessed.has(newEntry)) {
                    return []
                }
                alreadyProcessed.add(newEntry)
                // newEntry = path.posix.normalize(newEntry) // TODO does esbuild always use posix?
                const absPath = path.resolve(esbuildCwd, newEntry)
                const input = inputs[absPath]
                if (input == null) {
                    throw new Error(
                        `entry '${absPath}' is not present in esbuild metafile inputs ${JSON.stringify(
                            inputs,
                            null,
                            2,
                        )}`,
                    )
                }
                const currentImports = input.imports.map((x) => x.path)
                // newImports.push(...currentImports)
                result.push(
                    ...currentImports.map(
                        (x): TraversalResultType => {
                            return {
                                importer: path.resolve(esbuildCwd, newEntry),
                                resolvedImportPath: path.resolve(esbuildCwd, x),
                            }
                        },
                    ),
                )
                return currentImports
            }),
        ).filter(Boolean)
        toProcess = newImports
    }
    return unique(result, (x) => x.resolvedImportPath)
    // find the right output getting the key of the right output.inputs == input
    // get the imports of the inputs.[entry].imports and attach them the importer
    // do the same with the imports just found
    // return the list of input files
}
