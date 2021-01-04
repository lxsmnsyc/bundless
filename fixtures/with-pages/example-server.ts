import Koa from 'koa'
import send from 'koa-send'
import { build, Config, PluginsExecutor } from '@bundless/cli'
import path from 'path'
import mime from 'mime-types'
import { Plugin as PagedPlugin } from '@bundless/plugin-react-paged'
import { importPathToFile } from '@bundless/cli/dist/utils'
import { HmrGraph } from '@bundless/cli'

const root = __dirname
const builtAssets = path.resolve(root, 'out')

async function prepare() {
    await build({
        entries: ['index.html', 'about/index.html'], // TODO the server should compute the paths with a glob
        root,
        plugins: [PagedPlugin()],
        build: {
            outDir: builtAssets,
        },
    })
}

const app = new Koa()

const prepared = prepare()

app.use(async (_, next) => {
    await prepared
    return next()
})

app.use(serveStatic({ root: builtAssets }))

const productionPluginsExecutor = new PluginsExecutor({
    ctx: {
        root,
        config: { root },
        isBuild: true,
        graph: new HmrGraph({ root }),
    },
    // here the clientScriptSrc is different because it must be the one built by esbuild
    plugins: [PagedPlugin({ clientScriptSrc: '/index.js' })],
})

app.use(async (ctx, next) => {
    if (ctx.method !== 'GET') return next()

    const filePath = importPathToFile(root, ctx.path)

    // resolve load and transform the html with the pages plugin in prod mode
    const {
        contents,
        path: resolvedPath,
    } = await productionPluginsExecutor.resolveLoadTransform({
        path: filePath, // TODO i am passing a file path to resolve, maybe it's better to pas the ctx.path directly and let the url resolver handle it?
    })

    if (contents) {
        ctx.body = contents
        ctx.status = 200
        ctx.type = String(mime.lookup(resolvedPath)) || '*/*'
        return next()
    }
})

function serveStatic({ root }) {
    return async function staticServer(ctx, next) {
        await next()

        if (ctx.method !== 'HEAD' && ctx.method !== 'GET') return

        if (ctx.body != null || ctx.status !== 404) return

        try {
            await send(ctx, ctx.path, {
                index: 'index.html',
                hidden: true,
                root,
            })
        } catch (err) {
            if (err.status !== 404) {
                throw err
            }
        }
    }
}

app.listen(8080, () => console.log(`Listening at http://localhost:8080`))
