import { Plugin } from "rollup";
import { Build, Files } from "estack";
import path from "path";
import resolve from "resolve";
/**
 * This plugins resolves the local files imported by assets
 * of entry captured by EStack, this is to capture the
 * importers to associate observers
 * @param build
 * @param chunksJs
 * @param aliasJs
 * @param extensions
 */
export const pluginLocalResolve = (
    build: Build,
    chunksJs: Files,
    aliasJs: Files,
    extensions: string[]
): Plugin => ({
    name: "plugin-estack-js",
    resolveId(id, importer) {
        if (id.startsWith(".") && importer && build.hasFile(importer)) {
            const file = build.getFile(importer);
            resolve(
                id,
                {
                    basedir: path.dirname(importer),
                    extensions,
                },
                async (err, id) => {
                    if (!err) {
                        if (file) {
                            const childFile = build.addFile(id, {
                                load: true,
                                write: false,
                            });

                            if (childFile.type != "css") delete childFile.load;

                            build.addImporter(childFile, file);
                        }
                    }
                }
            );
        }
        return null;
    },
    buildStart(options) {
        for (const src in chunksJs) {
            const file = chunksJs[src];
            const { dest, write, load, hash } = file;
            const { base } = path.parse(dest);
            const fileName = (hash ? build.options.assets : "") + base;
            if (write && load) {
                this.emitFile({
                    type: "chunk",
                    id: src,
                    fileName,
                });
                aliasJs[fileName] = file;
            }
        }
    },
});
