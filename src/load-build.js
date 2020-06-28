import path from "path";
import { loadHtml } from "./load-html/load-html";
import { loadCss } from "./load-css/load-css";
import { isHtml, isCss, asyncFs, isJs } from "./utils/utils";
import { MARK_ROOT } from "./constants";
import { loadRollup } from "./load-rollup/load-rollup";

/**
 * @todo separar el logger del contexto para permitir multiples ejecuciones de loadBuild
 * @todo asociarLoadRollup
 * @todo permitir crear una instancia del plugins de css para que este acceda a la cache de archivos y no a readFIle
 * @todo dar soporte a alias para referenciar una pagina
 */

export async function loadBuild(build, files, forceBuild) {
    build.logger.mark(MARK_ROOT);

    files = files.map(path.normalize);

    let localResolveAsset = {};

    build.addRootAsset = (file) => {
        /**
         * to optimize the process, the promise that the file looks for is
         * cached, in order to reduce this process to only one execution between buils
         */
        async function resolve(file) {
            await asyncFs.stat(file);
            return build.getLink(build.getFileName(file));
        }

        localResolveAsset[file] = localResolveAsset[file] || resolve(file);

        return localResolveAsset[file];
    };

    let htmlFiles = files.filter(isHtml).filter(build.preventNextLoad);

    if (htmlFiles.length) {
        await loadHtml(build, htmlFiles);
    }

    files = [...files, ...Object.keys(localResolveAsset)];

    let cssFiles = files.filter(isCss).filter(build.preventNextLoad);
    let jsFiles = files.filter(isJs).filter(build.preventNextLoad);

    let staticFiles = files.filter(isNotFixLink).filter(prevenLoad);

    jsFiles =
        jsFiles.length || forceBuild
            ? Object.keys(build.inputs).filter(isJs)
            : [];

    let resolveCss = cssFiles.length && loadCss(build, cssFiles);
    let resolveJs = jsFiles.length && loadRollup(build, jsFiles);

    await Promise.all([
        resolveCss,
        resolveJs,
        ...staticFiles.map(async (file) => {
            let dest = build.getDest(build.getFileName(file));
            if (options.virtual) {
                build.mountFile({ dest, stream: file });
            } else {
                return build.copyFile(file, dest);
            }
        }),
    ]);

    build.logger.markBuild(MARK_ROOT);
}