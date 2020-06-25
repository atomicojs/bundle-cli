import glob from "fast-glob";
import path from "path";
import rollup from "rollup";
import builtins from "builtin-modules";
import {
  isJs,
  isMd,
  isUrl,
  isCss,
  isYaml,
  isHtml,
  isFixLink,
  isNotFixLink,
  isJsonContent,
  readFile,
  asyncFs,
  copyFile,
  writeFile,
  yamlParse,
  normalizePath,
  getPackage,
  getRelativePath,
  getRelativeDeep,
  request,
  queryPages,
  getMetaPage,
  logger,
  npmRun,
} from "./utils/utils";
import { createServer } from "./create-server";
import { rollupPlugins } from "./rollup/config-plugins";
import { readHtml } from "./read-html";
import { readCss } from "./read-css";
import { renderHtml } from "./template";
import { renderMarkdown } from "./markdown";
import { watch } from "./watch";
import {
  MARK_ROOT,
  MARK_ROLLLUP,
  ERROR_TRANSFORMING,
  DEEP_ALIAS,
  DEEP_REPLACE,
} from "./constants";

/**
 *
 * @param {Object} data -
 * @param {{prop:string,value:*}} mapProp -
 */
let mapPropToObject = (data, { prop, value }) => {
  data[prop] = value;
  return data;
};

export async function createBuild(options) {
  let server;

  let rollupWatchers = [];
  // cache de rollup
  let rollupCache = {};

  /**
   * @callback fileWatcher
   * @param {string} file - child file, any changes will escalate to the parent.
   * @param {string} parentFile - parent file
   * @param {boolean} rebuild - if true, any change will force the rebuild of the parentFile
   */

  /**@type {fileWatcher} */
  let fileWatcher;

  // stores the status of processed files
  let inputs = {};

  let cacheFetch = {};

  let exportCondition = {};

  // format options
  options = await formatOptions(options);

  // get list based on input expression
  let files = await glob(options.src);

  let playLog = logger.load();
  /**
   * returns the write destination of the file
   * @param {string} file - file name
   * @param {string} [folder] - If defined, add the folder to the destination
   */
  let getDest = (file, folder = "") =>
    normalizePath(path.join(options.dest, folder, file));

  /**
   * Check if the file is locked
   * @param {string} file
   * @returns {boolean}
   */
  let isPreventLoad = (file) => file in inputs;

  /**
   * check if the file can be processed
   * @param {stirng} file
   * @return {boolean}
   */
  let isNotPreventLoad = (file) => !isPreventLoad(file);

  let debugRoot = (message) => logger.debug(message, MARK_ROOT);
  let debugRollup = (message) => logger.debug(message, MARK_ROLLLUP);
  let footerLog = logger.footer("");

  async function markBuild(mark) {
    if (options.runAfterBuild) logger.mark(options.runAfterBuild);
    await logger.markBuild(mark);
    if (options.runAfterBuild) {
      try {
        await npmRun(options.runAfterBuild, footerLog);
        logger.markBuild(options.runAfterBuild);
      } catch (e) {
        logger.markBuildError(options.runAfterBuild, footerLog);
      }
    }
  }

  function deleteInput(file) {
    delete inputs[file];
    return file;
  }

  /**
   * gets the file name based on its type
   * @param {string} file
   */
  function getFileName(file) {
    let { name, ext } = path.parse(file);

    return normalizePath(
      isFixLink(ext)
        ? name + (isJs(ext) ? ".js" : isMd(ext) ? ".html" : ext)
        : file.split("").reduce((out, i) => (out + i.charCodeAt(0)) | 8, 4) +
            "-" +
            name +
            ext
    );
  }
  /**
   * prevents the file from working more than once
   * @param {string} file
   */
  function prevenLoad(file) {
    if (file in inputs) {
      return false;
    } else {
      return (inputs[file] = true);
    }
  }

  if (options.server) {
    try {
      server = await createServer({
        root: options.dest,
        port: options.port,
        reload: options.watch,
        proxy: options.proxy,
      });
    } catch (e) {
      console.log(e);
    }

    logger.header(`Server running on http://localhost:${server.port}`);
  }

  function mountFile({ dest, code, type, stream }) {
    if (options.virtual) {
      server.sources[dest] = { code, stream, type, stream };
    } else {
      return writeFile(dest, code);
    }
  }

  playLog();

  /**
   * initialize the processing queue on related files
   * @param {string[]} files - list of files to process
   * @param {*} forceBuild
   */
  async function load(files, forceBuildRollup) {
    // reset build start time
    logger.mark(MARK_ROOT);

    files = files.map(path.normalize);
    // html files are added to this list to check if a rebuild of html files is necessary
    let rebuildHtml = [];
    // prevents a second check if the file is added again from the html
    let localScan = {};

    /**
     * First the html files will be obtained
     * to extract the assets from these,
     * assets will be grouped in the variable nestedFiles
     */
    let nestedFiles = await Promise.all(
      files
        .filter(isHtml)
        .filter(prevenLoad)
        .map(async (file) => {
          rebuildHtml.push(file); // this will rebuild all the html files

          let { dir, name } = path.parse(file);

          let html = await readFile(file);

          let data = [html, {}];

          try {
            data = getMetaPage(html);
          } catch (e) {
            debugRoot(
              `${ERROR_TRANSFORMING} ${file}:${e.mark.line}:${e.mark.position}`
            );
          }

          let [code, meta] = data;

          if (!options.watch && meta.draft) {
            deleteInput(file);
            return [];
          }

          name = meta.name || name;

          let fileName = name + ".html";
          let dest = getDest(fileName, meta.folder);
          let link = normalizePath(
            "/" + path.join(meta.folder || "", name == "index" ? "/" : name)
          );
          let nestedFiles = [];

          function addFile(childFile) {
            if (isUrl(childFile)) return childFile;

            let findFile = path.join(dir, childFile);
            /**
             * to optimize the process, the promise that the file looks for is
             * cached, in order to reduce this process to only one execution between buils
             */
            async function resolveChildFile() {
              try {
                await asyncFs.stat(findFile);
                nestedFiles.push(findFile);
                fileWatcher && fileWatcher(findFile, file);
                return {
                  file: findFile,
                  src: DEEP_ALIAS + getFileName(findFile),
                };
              } catch (e) {
                return { src: childFile };
              }
            }

            localScan[findFile] = localScan[findFile] || resolveChildFile();

            return localScan[findFile];
          }

          if (isMd(file)) {
            code = renderMarkdown(code);
          }
          /**
           * The following process is in charge of transforming the
           * fetch object to the data declared in the request
           */
          let resolveMetaFetch = () =>
            meta.fetch &&
            Promise.all(
              Object.keys(meta.fetch).map(async (prop) => {
                let value = meta.fetch[prop];
                try {
                  if (isUrl(value)) {
                    cacheFetch[value] = cacheFetch[value] || request(value);
                    value = await cacheFetch[value];
                  } else {
                    /**
                     * If the file is local, an observer relationship will be added,
                     * this allows relating the data obtained from the external document
                     * to the template and synchronizing the changes
                     */
                    let findFile = path.join(dir, value);

                    fileWatcher && fileWatcher(findFile, file, true);

                    try {
                      value = await readFile(findFile);

                      value = isYaml(findFile)
                        ? yamlParse
                        : isJsonContent(value)
                        ? JSON.parse(value)
                        : value;
                    } catch (e) {}
                  }
                } catch (e) {
                  debugRoot(`FetchError: ${file} : src=${value}`);
                }
                return {
                  prop,
                  value,
                };
              })
            ).then((data) => data.reduce(mapPropToObject, {}));
          /**
           * The following process allows the allocation of aliases for each file to process
           */
          let resolveMetaFiles = () =>
            meta.files &&
            Promise.all(
              Object.keys(meta.files).map(async (prop) => {
                let value = meta.files[prop];
                if (typeof value == "object") {
                  let { src, ...config } = value;
                  value = await addFile(src);
                  if (value.file) {
                    let nextConfig = {
                      id: prop,
                      share: true,
                      ...config,
                    };
                    if (
                      exportCondition[value.file] &&
                      JSON.stringify(exportCondition[value.file]) !=
                        JSON.stringify(nextConfig)
                    ) {
                      deleteInput(value.file);
                    }
                    exportCondition[value.file] = nextConfig;
                  }
                  value = value.src;
                } else {
                  value = (await addFile(value)).src;
                }
                return {
                  prop,
                  value,
                };
              })
            ).then((files) => files.reduce(mapPropToObject, {}));
          // These processes can be solved in parallel
          let [content, fetch, aliasFiles] = await Promise.all([
            readHtml({
              code: meta.content || code, //content can also be defined in the meta
              addFile: async (file) => (await addFile(file)).src,
            }),
            resolveMetaFetch(),
            resolveMetaFiles(),
          ]);

          inputs[file] = {
            ...meta,
            fetch,
            files: aliasFiles,
            file: normalizePath(file),
            name,
            fileName,
            content,
            link,
            dest,
          };

          return nestedFiles;
        })
    );

    files = [...files, ...nestedFiles.flat()];

    let resolveHtmlFiles = [];

    let resolveCssFiles = files
      .filter(isCss)
      .filter(prevenLoad)
      .map(async (file) => {
        let css = await readFile(file);
        let code = await readCss({
          code: css,
          file,
          addWatchFile(childFile) {
            if (options.watch) {
              fileWatcher && fileWatcher(childFile, file, true);
            }
          },
        });
        return mountFile({
          dest: getDest(getFileName(file)),
          code,
          type: "css",
        });
      });

    if (rebuildHtml.length) {
      /**
       * The templates files are virtual, these can be referred
       * by a file that declares layour for use of this
       */
      let templates = {};

      let fragments = {};
      /**
       * The files are virtual and it allows to generate a query
       * on the pages in order to create page collections
       */
      let archives = [];

      // The following processes separate the files according to their use
      let pages = Object.keys(inputs)
        .filter(isHtml)
        .map((file) => {
          let data = inputs[file];
          if (data.fragment) {
            fragments[data.fragment] = data;
            return;
          }
          if (data.template) {
            templates[data.template] = data;
            return;
          }
          if (data.archive) {
            archives.push(data);
            return;
          }
          return data;
        })
        .filter((value) => value);

      pages = [
        ...pages,
        ...archives
          .map(({ archive, ...page }) => {
            let collection = queryPages(pages, archive);
            let folderLink = page.link;
            return collection.map((pages, paged) => {
              // Create the pages manually, they are the configuration
              let name = paged ? "/" + paged : "";
              let fileName = paged ? folderLink + name : folderLink;
              let dest = getDest(fileName + ".html");

              let link = normalizePath("/" + fileName);

              let position = paged - 1;
              let prev = collection[position]
                ? getRelativePath(
                    link,
                    folderLink + (position ? "/" + position : "")
                  )
                : false;

              position = paged + 1;

              let next = collection[position]
                ? getRelativePath(
                    link,
                    folderLink + (position ? "/" + position : "")
                  )
                : false;

              return {
                ...page,
                name: fileName,
                dest,
                link,
                pages, // The pages context will only be based on the scope of the archive
                pagination: {
                  prev,
                  next,
                  paged,
                },
              };
            });
          })
          .flat(),
      ];

      let resolvedPages = {};
      /**
       * First resolve the pages independently,
       * this allows each page to interact with
       * its scope page before associating the
       * nested render on the layout
       */
      resolveHtmlFiles = pages.map(
        async ({ pages: scopePages, query, ...page }) => {
          let layout = templates[page.layout == null ? "default" : page.layout];
          let createRelativeLink = (subPage) => ({
            ...subPage,
            /**
             * Access to content is suppressed, this is only a scope as metadata,
             * since in itself the content has not been rendered in this section
             * with the context of the page. This is only allowed from template pages
             */
            get content() {
              return resolvedPages[subPage.file];
            },
            link: getRelativePath(page.link, subPage.link),
          });

          if (query) {
            query = Object.keys(query)
              .map((prop) => ({
                prop,
                value: queryPages(
                  pages,
                  {
                    onlyPages: true,
                    ...query[prop],
                  },
                  createRelativeLink
                ),
              }))
              .reduce(mapPropToObject, {});
          }
          let data = {
            pkg: options.pkg,
            build: !options.watch,
            query,
            page,
            layout,
            fragments,
            deep: getRelativeDeep(page.link),
            archive: !!scopePages,
            pages: (scopePages || pages).map(createRelativeLink),
          };

          try {
            let content = (resolvedPages[page.file] = await renderHtml(
              page.content,
              data
            ));
            return { ...data, page: { ...page, content } };
          } catch (e) {
            debugRoot(`${ERROR_TRANSFORMING} : ${page.file}`);
          }
        }
      );

      resolveHtmlFiles = [
        /**
         * expect all page renders to be resolved, before hierarchical
         * template construction, this is to access all the content
         * associated with the previous render
         */
        Promise.all(resolveHtmlFiles).then((pages) =>
          Promise.all(
            /**
             * Write the files once all have generated render of their
             * individual content, this in order to create pages that
             * group the content of other pages already processed
             */
            pages.map(async (data) => {
              if (!data) return;
              let content = data.page.content;
              if (data.layout) {
                /**
                 * If the layout used by the page has the singlePage configuration,
                 * it will only generate the page that this property of fine based on its name
                 * @example
                 * singlePage : index
                 */
                if (
                  data.layout.singlePage &&
                  data.layout.singlePage !== data.page.name
                ) {
                  return;
                }
                try {
                  content = await renderHtml(data.layout.content, {
                    ...data,
                    // The layout can inherit the pages
                    pages: data.archive
                      ? data.pages
                      : pages.map(({ page: subPage }) => ({
                          ...subPage,
                          link: getRelativePath(data.page.link, subPage.link),
                        })),
                  });
                } catch (e) {
                  debugRoot(`${ERROR_TRANSFORMING} : ${data.layout.file}`);
                }
              }

              if (content != null) {
                return mountFile({
                  dest: data.page.dest,
                  code: content.replace(DEEP_REPLACE, data.deep), // ensures the relative use of all files declared before writing
                  type: "html",
                });
              }
            })
          )
        ),
      ];
    }

    // parallel queue of asynchronous processes
    await Promise.all([
      ...resolveCssFiles,
      ...resolveHtmlFiles,
      ...files // copy of static files
        .filter(isNotFixLink)
        .filter(prevenLoad)
        .map(async (file) => {
          let dest = getDest(getFileName(file));
          if (options.virtual) {
            mountFile({ dest, stream: file });
          } else {
            return copyFile(file, dest);
          }
        }),
      ...(files.filter(isJs).filter(prevenLoad).length || forceBuildRollup
        ? [resolveFilesJs()]
        : []),
    ]);

    //logger.markBuild(MARK_ROOT);
    await markBuild(MARK_ROOT);

    server && server.reload();
  }
  /**
   * Scope of the rollup process running in parallel to the EStack process
   */
  function resolveFilesJs() {
    let countBuild = 0; // Ignore the first build since it synchronizes the reload from root
    // clean the old watcher
    rollupWatchers.filter((watcher) => watcher.close());
    rollupWatchers = [];

    let customConfig = new Map();

    let groups = Object.keys(inputs)
      .filter(isJs)
      .sort()
      .reduce(
        (list, file) => {
          let config = exportCondition[file];
          if (config && !config.share) {
            customConfig.set(file, config);
            list.push(file);
          } else {
            list[0].push(file);
          }
          return list;
        },
        [[]]
      );

    return Promise.all(
      groups.map(async (group, id) => {
        let config = customConfig.get(group) || {};
        let mark = MARK_ROLLLUP + (id ? ":" + (config.id || id) : "");
        let input = {
          input: group,
          onwarn: debugRollup,
          external: options.external,
          cache: rollupCache[id],
          plugins: rollupPlugins(
            options,
            options.virtual &&
              ((source) => mountFile({ ...source, dest: getDest(source.dest) }))
          ),
        };

        if (input.input.length) {
          let output = {
            dir: options.dest,
            format: "es",
            sourcemap: options.sourcemap,
          };

          if (options.watch) {
            logger.mark(mark);
          }

          let bundle = await rollup.rollup(input);

          rollupCache[id] = bundle.cache;

          if (options.watch) {
            let watcher = rollup.watch({
              ...input,
              output,
              watch: { exclude: "node_modules/**" },
            });

            watcher.on("event", async (event) => {
              switch (event.code) {
                case "START":
                  logger.mark(mark);
                  break;
                case "END":
                  await markBuild(mark);
                  countBuild++ && server && server.reload();
                  break;
                case "ERROR":
                  logger.markBuildError(event.error, mark);
                  break;
              }
            });

            rollupWatchers.push(watcher);

            if (server) return;
          } else {
            await bundle.write(output);
          }
        }
      })
    );
  }

  if (options.watch) {
    // map defining the cross dependencies between child and parents
    let mapSubWatch = {};

    let watcher = watch(options.src, (group) => {
      let files = [];
      let forceBuild;

      if (group.add) {
        let groupFiles = group.add.filter(isFixLink).filter(isNotPreventLoad);
        files = [...files, ...groupFiles];
      }
      if (group.change) {
        let groupChange = group.change.filter((file) => !isJs(file)); // ignore js file changes

        let groupFiles = [
          ...groupChange, // keep files that have changed in the queue
          ...groupChange // add new files based on existing ones in the queue
            .filter((file) => mapSubWatch[file])
            .map((file) =>
              Object.keys(mapSubWatch[file]).filter(
                (subFile) => mapSubWatch[file][subFile]
              )
            )
            .flat(),
        ]
          .filter(isPreventLoad)
          .map(deleteInput);

        files = [...files, ...groupFiles];
      }

      if (group.unlink) {
        group.unlink.forEach(deleteInput);
        forceBuild = true;
      }

      if (files.length || forceBuild) {
        load(files, forceBuild);
      }
    });

    fileWatcher = (file, parentFile, rebuild) => {
      if (!mapSubWatch[file]) {
        mapSubWatch[file] = {};
        watcher.add(file);
      }
      if (parentFile) {
        mapSubWatch[file][parentFile] = rebuild;
      }
    };
  }

  try {
    await load(files);
    return options;
  } catch (e) {
    //await logger.markBuildError(e, MARK_ROOT);
    console.log(e);
    process.exit();
  }
}

async function formatOptions({
  src = [],
  config,
  external,
  jsx,
  jsxFragment,
  runAfterBuild,
  forceWrite,
  silent,
  ...ignore
}) {
  if (silent) process.env.silent = true;

  let pkg = await getPackage();

  src = Array.isArray(src) ? src : src.split(/ *; */g);

  if (external) {
    external = Array.isArray(external)
      ? external
      : [true, "true"].includes(external)
      ? Object.keys(pkg.dependencies)
      : external.split(/ *, */);
  }

  external = [
    ...builtins,
    ...(external || []),
    ...Object.keys(pkg.peerDependencies),
  ];

  let options = {
    src,
    external,
    ...ignore,
    ...pkg[config],
    pkg,
    virtual: !forceWrite && ignore.watch && ignore.server,
    runAfterBuild: pkg.scripts[runAfterBuild] ? runAfterBuild : "",
    jsx: jsx == "react" ? "React.createElement" : jsx,
    jsxFragment: jsx == "react" ? "React.Fragment" : jsxFragment,
  };

  // normalize routes for fast-glob
  options.src = options.src.map(normalizePath);

  return options;
}