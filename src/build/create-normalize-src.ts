import path from "path";

interface Normalizes {
    [src: string]: string;
}

interface Records {
    [src: string]: any;
}

const cwd = process.cwd();

const normalizes: Normalizes = {};

export const createNormalizeSrc = (records: Records) => (src: string) => {
    if (records[src]) return src;
    if (!normalizes[src]) {
        // if (src.startsWith(cwd)) {
        //     normalizes[src] = src;
        // } else {
        //     normalizes[src] = path.join(cwd, src);
        // }
        normalizes[src] = path.relative(cwd, src);
    }
    return normalizes[src];
};
