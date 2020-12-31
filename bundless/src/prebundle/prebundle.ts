import fs from 'fs-extra'
import path from 'path'
import { COMMONJS_ANALYSIS_PATH } from '../constants'
import { logger } from '../logger'
import { clearCommonjsAnalysisCache } from '../plugins/rewrite/commonjs'
import { bundleWithEsBuild } from './esbuild'
import { printStats } from './stats'
import { osAgnosticPath } from './support'
import { traverseWithEsbuild } from './traverse'

export async function prebundle({ entryPoints, plugins, filter, root, dest }) {
    const traversalResult = await traverseWithEsbuild({
        entryPoints,
        root,
        plugins,
        stopTraversing: filter,
        esbuildCwd: process.cwd(),
    })

    const dependenciesPaths = traversalResult.filter(filter)

    logger.log(
        `prebundling [${dependenciesPaths
            .map((x) => osAgnosticPath(x, root))
            .join(', ')}]`,
    )

    await fs.remove(dest)
    const { bundleMap, analysis, stats } = await bundleWithEsBuild({
        dest,
        root,
        plugins,
        entryPoints: dependenciesPaths.map((x) => path.resolve(root, x)),
    })

    const analysisFile = path.join(dest, COMMONJS_ANALYSIS_PATH)
    await fs.createFile(analysisFile)

    await fs.writeFile(analysisFile, JSON.stringify(analysis, null, 4))
    clearCommonjsAnalysisCache()
    console.info(printStats(stats))
    return bundleMap
}

// on start, check if already optimized dependencies, else
// traverse from entrypoints and get all imported paths, stopping when finding a node_module
// start bundling these modules and store them in a web_modules folder
// save a commonjs modules list in web_modules folder
// this can be a plugin that start building when finding a new node_modules plugin that should not be there
// if it sees a path that has a node_modules inside it blocks the server, start bundling and restart everything
