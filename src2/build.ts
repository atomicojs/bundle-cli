import {
    File,
    Options,
    Build,
    Plugin,
    LogBody,
    PluginContext,
    PluginsMessages,
} from "estack";
import * as path from "path";
import * as glob from "fast-glob";
import createTree, { Context } from "@uppercod/imported";
import { load } from "./load";
import { createDataDest } from "./link";
import { createWatch, Group } from "./watch";
import { isHtml } from "./utils/types";
import { readFile } from "./utils/fs";
import { createMarks } from "./utils/mark";
import { createLog } from "./log";
import { loadOptions } from "./options";
import { pluginHtml } from "./plugins/html";
import { pluginData } from "./plugins/data";
import { pluginServer } from "./plugins/server";
import { pluginJs } from "./plugins/js";
import { pluginWrite } from "./plugins/write";

type Cycle = (listSrc: string[]) => Promise<void>;

export async function createBuild(opts: Options) {
    const options = await loadOptions(opts);
    const listSrc = await glob(options.src);

    const tree = createTree();

    const log = createLog({
        build: "Built in [bold.green $], Found [bold.red $] errors.",
        footer: options.watch ? "\nWatching for file changes...\n" : "",
    });

    const mark = createMarks();

    const getDest = createDataDest(options);

    const getSrc = (src: string) => path.normalize(src);
    const hasFile = (src: string) => tree.has(getSrc(src));
    const getFile = (src: string): File => tree.get(getSrc(src));
    const isAssigned = (src: string) => {
        if (hasFile(src)) {
            return getFile(src).assigned;
        }
        return false;
    };
    const addFile = (
        src: string,
        { isRoot = true, watch = true, hash = true, write = true }
    ) => {
        src = getSrc(src);
        const file: File = tree.get(src);
        /**@todo check use */
        file.watch = file.watch ?? watch;
        file.write = file.write ?? write;
        if (isRoot) tree.add(src);
        if (!file.setLink) {
            Object.assign(file, {
                ...getDest(src, hash),
                errors: [],
                alerts: [],
                read: () => readFile(src),
                join: (src: string) => path.join(file.raw.dir, src),
                async addChild(src: string) {
                    src = getSrc(file.join(src));
                    const exist = build.hasFile(src);
                    tree.addChild(file.src, src);
                    if (!exist) {
                        if (watcher) watcher.add(src);
                        await load(build, [src]);
                    }
                    return build.getFile(src);
                },
                async addLink(src: string) {
                    if (isHtml(src)) {
                        const nextSrc = file.join(src);
                        return {
                            get link() {
                                return getFile(nextSrc).link;
                            },
                            get linkTitle() {
                                return getFile(nextSrc).data.linkTitle;
                            },
                        };
                    } else {
                        const {
                            link,
                            raw: { base: linkTitle },
                        } = await file.addChild(src);
                        return { link, linkTitle };
                    }
                },
                setLink(...args: string[]): string {
                    const { raw } = file;
                    Object.assign(file, getDest(path.join(...args)), hash);
                    file.raw = raw;
                    return file.link;
                },
                addError(message: string) {
                    message += "";
                    if (!file.errors.includes(message)) {
                        file.errors.push(message);
                    }
                },
                addAlert(message: string) {
                    message += "";
                    if (!file.alerts.includes(message)) {
                        file.alerts.push(message);
                    }
                },
            } as File);
        }
        return file;
    };

    const build: Build = {
        log,
        mode: "dev",
        global: {},
        files: tree.tree,
        plugins: [
            pluginHtml(),
            pluginData(),
            pluginJs(),
            options.server ? pluginServer() : pluginWrite(),
        ].filter((plugin) => plugin),
        getSrc,
        addFile,
        hasFile,
        getFile,
        getDest,
        isAssigned,
        options,
    };

    const pluginsParallel = (
        method: Exclude<keyof Plugin, "name" | "load" | "filter">
    ) =>
        Promise.all(
            build.plugins.map(
                (plugin) =>
                    typeof plugin[method] == "function" && plugin[method](build)
            )
        );

    const pluginsSequential = (
        method: Exclude<keyof Plugin, "name" | "load" | "filter">
    ) =>
        build.plugins.reduce(
            (promise, plugin) =>
                typeof plugin[method] == "function"
                    ? promise.then(() => plugin[method](build))
                    : promise,
            Promise.resolve()
        );

    const pluginsMessages: PluginsMessages = {};

    build.plugins.forEach((plugin: PluginContext) => {
        if (!pluginsMessages[plugin.name]) {
            pluginsMessages[plugin.name] = { errors: [], alerts: [] };
        }
        let currentMark: () => string;
        plugin.log = {
            clear() {
                currentMark = mark(plugin.name);
                pluginsMessages[plugin.name] = { errors: [], alerts: [] };
            },
            errors(errors: LogBody[]) {
                pluginsMessages[plugin.name].errors.push(...errors);
            },
            alerts(alerts: LogBody[]) {
                pluginsMessages[plugin.name].alerts.push(...alerts);
            },
            build() {
                buildLog(currentMark ? currentMark() : "0ms");
            },
        };
    });

    await pluginsParallel("mounted");

    const buildLog = (time: string) => {
        const errors: LogBody[] = [];
        const alerts: LogBody[] = [];

        for (const name in pluginsMessages) {
            const log = pluginsMessages[name];
            errors.push(...log.errors);
            alerts.push(...log.alerts);
        }

        for (const src in build.files) {
            const file = build.files[src];

            file.errors.length &&
                errors.push({
                    src: file.src,
                    items: file.errors,
                });

            file.alerts.length &&
                alerts.push({
                    src: file.src,
                    items: file.errors,
                });
        }

        alerts.length &&
            log.print({
                type: "alert",
                message: "",
                body: alerts,
            });

        log.print({
            type: "error",
            message: "build",
            params: [time, errors.length + ""],
            body: errors,
        });

        log.print({
            type: "raw",
            message: "footer",
        });
    };

    const cycle: Cycle = async (listSrc: string[]) => {
        const closeMark = mark("build");

        await pluginsSequential("buildStart");
        await pluginsParallel("beforeLoad");
        await load(build, listSrc, true);
        await pluginsParallel("afterLoad");
        await pluginsSequential("buildEnd");

        buildLog(closeMark());
    };

    const watcher =
        options.watch &&
        createWatch({
            glob: options.src,
            listener: createListenerWatcher(tree, cycle),
        });

    await cycle(listSrc);
}

const createListenerWatcher = (tree: Context, cycle: Cycle) => (
    group: Group
) => {
    let files: string[] = [];
    const { unlink = [] } = group;
    if (group.change) {
        const change = group.change
            .map((src): string[] => {
                if (tree.has(src)) {
                    const file: File = tree.get(src);
                    const roots = tree.getRoots(src);
                    if (file.watch) unlink.push(src);
                    return roots;
                }
                return [];
            })
            .flat();

        files.push(...change);
    }

    if (unlink) {
        unlink.forEach((src) => tree.remove(src));
    }

    if (group.add) {
        files.push(...group.add);
    }

    if (files.length) {
        cycle(files);
    }
};
